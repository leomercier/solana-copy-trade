// copy_trader.js
const { Connection, PublicKey, clusterApiUrl, Keypair, VersionedTransaction, Transaction, MessageV0 } = require('@solana/web3.js'); // Added MessageV0
const { NATIVE_MINT } = require('@solana/spl-token'); // Import NATIVE_MINT for SOL checks
const bs58 = require('bs58');
const axios = require('axios'); // For Jupiter API calls
require('dotenv').config(); // To load environment variables

// --- Configuration ---
// Load from environment variables
const RPC_URL = process.env.RPC_URL || clusterApiUrl('mainnet-beta'); // Use mainnet-beta for real trades, devnet for testing
const SOURCE_WALLET_ADDRESS = process.env.SOURCE_WALLET_ADDRESS; // Wallet to monitor
const TARGET_WALLET_PRIVATE_KEY_BS58 = process.env.TARGET_WALLET_PRIVATE_KEY; // Private key for your trading wallet
const TRADE_PROPORTION = parseFloat(process.env.TRADE_PROPORTION) || 0.1; // Example: Copy 10% of the value, or implement different logic
const MIN_TRADE_VALUE_USD = parseFloat(process.env.MIN_TRADE_VALUE_USD) || 10; // Minimum trade value in USD to copy

// --- Constants ---
// Jupiter V6 Program ID - Note: Jupiter uses multiple programs, this is a common one.
const JUPITER_V6_PROGRAM_ID = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const SOL_MINT_ADDRESS = NATIVE_MINT.toBase58(); // Store SOL mint address as string

// --- Validate Configuration ---
if (!SOURCE_WALLET_ADDRESS) {
    console.error("Error: SOURCE_WALLET_ADDRESS environment variable is not set.");
    process.exit(1);
}
if (!TARGET_WALLET_PRIVATE_KEY_BS58) {
    console.error("Error: TARGET_WALLET_PRIVATE_KEY environment variable is not set.");
    process.exit(1);
}

let targetWalletKeyPair;
try {
    targetWalletKeyPair = Keypair.fromSecretKey(bs58.decode(TARGET_WALLET_PRIVATE_KEY_BS58));
    console.log(`Target wallet loaded: ${targetWalletKeyPair.publicKey.toBase58()}`);
} catch (error) {
    console.error("Error decoding target wallet private key:", error.message);
    process.exit(1);
}

// --- Solana Connection ---
const connection = new Connection(RPC_URL, 'confirmed');

// --- Main Monitoring Logic ---
async function monitorWallet() {
    console.log(`Monitoring wallet: ${SOURCE_WALLET_ADDRESS} on ${RPC_URL}`);
    console.log(`Target wallet: ${targetWalletKeyPair.publicKey.toBase58()}`);
    console.log(`Trade Proportion/Logic: ${TRADE_PROPORTION * 100}% (or custom logic)`);
    console.log(`Minimum Trade Value (USD): ${MIN_TRADE_VALUE_USD}`);


    try {
        const sourcePublicKey = new PublicKey(SOURCE_WALLET_ADDRESS);

        connection.onLogs(
            sourcePublicKey,
            async (logsResult, context) => {
                const { signature, logs, err } = logsResult;
                if (err) {
                    // console.warn(`Error in logs for ${signature}:`, err);
                    return; // Often errors are for unrelated instructions, ignore for monitoring
                }

                // Basic check for Jupiter program ID in logs (can be prone to false positives/negatives)
                const isJupiterV6Log = logs.some(log => log.includes(JUPITER_V6_PROGRAM_ID.toBase58()));
                const isSwapLog = logs.some(log => log.includes("Program log: Instruction: Swap") || log.includes("Program log: Route"));

                // Prioritize checking logs first as it's faster than fetching the full tx
                if (isJupiterV6Log || isSwapLog) {
                    console.log(`\nPotential Jupiter interaction detected via logs: ${signature}`);
                    console.log(`Fetching transaction details...`);
                    // Add a small delay to allow RPC nodes to sync transaction details fully
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    await processTransaction(signature, context.slot);
                }
            },
            'confirmed' // Commitment level
        );

        console.log("Subscription active. Waiting for transactions...");

    } catch (error) {
        console.error("Error setting up monitoring:", error);
    }
}

// --- Transaction Processing ---
async function processTransaction(signature, slot) {
    try {
        const tx = await connection.getTransaction(signature, {
            maxSupportedTransactionVersion: 0, // Specify version to ensure parsing works for Versioned Transactions
            commitment: 'confirmed'
        });

        if (!tx || !tx.meta) {
            console.log(`[${signature}] Transaction details not found or meta missing.`);
            return;
        }

        if (tx.meta.err) {
            console.log(`[${signature}] Transaction failed. Skipping.`);
            return;
        }

        console.log(`[${signature}] Processing transaction version: ${tx.version ?? 'legacy'}`);
        //console.log(JSON.stringify(tx.transaction.message, null, 2)); // Debug: Print the full message structure
        //console.log(JSON.stringify(tx.meta, null, 2)); // Debug: Print the full meta structure


        // --- Robust Jupiter Check ---
        let isJupiterTx = false;
        const message = tx.transaction.message;
        let accountKeys = []; // Will hold the list of accounts involved

        if (message instanceof MessageV0) { // Check if it's a MessageV0 (Versioned Transaction)
            console.log(`[${signature}] Checking MessageV0 staticAccountKeys...`);
             accountKeys = message.staticAccountKeys.map(pk => pk.toBase58()); // Get keys as strings
            // In MessageV0, program IDs are listed in staticAccountKeys
            isJupiterTx = message.staticAccountKeys.some(key =>
                key.equals(JUPITER_V6_PROGRAM_ID)
            );

            // Note: Checking ATLs for Jupiter Program ID is usually not necessary and adds complexity

        } else { // It's a legacy transaction
             console.log(`[${signature}] Checking legacy instructions...`);
             accountKeys = message.accountKeys.map(pk => pk.toBase58()); // Get keys as strings
            isJupiterTx = message.instructions.some(ix =>
                ix.programId.equals(JUPITER_V6_PROGRAM_ID)
            );
        }


        if (!isJupiterTx) {
             console.log(`[${signature}] Not confirmed as Jupiter V6 swap via account/instruction check.`);
             return;
        }


        console.log(`[${signature}] Confirmed Jupiter V6 program ID involved in transaction.`);

        // --- Extract Swap Details (SPL Tokens & SOL) ---
        const { preTokenBalances, postTokenBalances, preBalances, postBalances } = tx.meta;

        let inputTokenMint = null, outputTokenMint = null;
        let inputAmount = 0n, outputAmount = 0n;

        // 1. Check SPL Token Balance Changes
        const sourceTokenAccounts = new Map();
        if (preTokenBalances && Array.isArray(preTokenBalances)) {
            preTokenBalances.forEach(bal => {
                if (bal.owner === SOURCE_WALLET_ADDRESS && bal.uiTokenAmount?.amount) { // Check owner and amount exists
                    sourceTokenAccounts.set(bal.accountIndex, {
                        mint: bal.mint,
                        preAmount: BigInt(bal.uiTokenAmount.amount)
                    });
                }
            });
        }
        if (postTokenBalances && Array.isArray(postTokenBalances)) {
            postTokenBalances.forEach(bal => {
                if (sourceTokenAccounts.has(bal.accountIndex) && bal.uiTokenAmount?.amount) {
                    sourceTokenAccounts.get(bal.accountIndex).postAmount = BigInt(bal.uiTokenAmount.amount);
                } else if (bal.owner === SOURCE_WALLET_ADDRESS && bal.uiTokenAmount?.amount) {
                    // Handle cases where a new token account was created for the source wallet
                    sourceTokenAccounts.set(bal.accountIndex, {
                        mint: bal.mint,
                        preAmount: 0n, // New account starts with 0 preBalance *in this tx*
                        postAmount: BigInt(bal.uiTokenAmount.amount)
                    });
                }
            });
        }

        // Determine SPL input/output
        for (const [, data] of sourceTokenAccounts.entries()) {
            data.postAmount = data.postAmount ?? data.preAmount; // Default to preAmount if postAmount is missing
            const diff = data.postAmount - data.preAmount;

            if (diff < 0n && !inputTokenMint) { // Decreased balance -> Input
                inputTokenMint = data.mint;
                inputAmount = -diff;
            } else if (diff > 0n && !outputTokenMint) { // Increased balance -> Output
                outputTokenMint = data.mint;
                outputAmount = diff;
            }
        }

        // 2. Check SOL Balance Changes
        const sourceWalletIndex = accountKeys.findIndex(key => key === SOURCE_WALLET_ADDRESS);
        let solChange = 0n;

        if (sourceWalletIndex !== -1 && preBalances && postBalances && preBalances.length > sourceWalletIndex && postBalances.length > sourceWalletIndex) {
             const preSol = BigInt(preBalances[sourceWalletIndex]);
             const postSol = BigInt(postBalances[sourceWalletIndex]);
             solChange = postSol - preSol;
             console.log(`[${signature}] SOL balance change for ${SOURCE_WALLET_ADDRESS}: ${solChange.toString()} lamports`);

            if (solChange < 0n) { // SOL decreased -> SOL was input
                 if (!inputTokenMint) { // If no SPL input was detected yet
                    inputTokenMint = SOL_MINT_ADDRESS; // Assign SOL as input
                    inputAmount = -solChange;
                 } else {
                    // This case (SPL input AND SOL input) is unusual for a single swap
                    console.warn(`[${signature}] Detected both SPL input (${inputTokenMint}) and SOL input. Check transaction details.`);
                 }
            } else if (solChange > 0n) { // SOL increased -> SOL was output
                 if (!outputTokenMint) { // If no SPL output was detected yet
                    outputTokenMint = SOL_MINT_ADDRESS; // Assign SOL as output
                    outputAmount = solChange;
                 } else {
                     // This case (SPL output AND SOL output) is unusual for a single swap
                     console.warn(`[${signature}] Detected both SPL output (${outputTokenMint}) and SOL output. Check transaction details.`);
                 }
            }
        } else {
            console.log(`[${signature}] Could not find source wallet index or SOL balances to check SOL change.`);
        }


        // 3. Final Determination and Execution
        if (inputTokenMint && outputTokenMint && inputAmount > 0n) {
            const inputDisplay = inputTokenMint === SOL_MINT_ADDRESS ? "SOL" : inputTokenMint;
            const outputDisplay = outputTokenMint === SOL_MINT_ADDRESS ? "SOL" : outputTokenMint;

            console.log(`[${signature}] Swap Detected for ${SOURCE_WALLET_ADDRESS}:`);
            console.log(`   Input : ${inputAmount.toString()} of ${inputDisplay}`);
            console.log(`   Output: ${outputAmount.toString()} of ${outputDisplay}`);

            // --- !!! DANGER ZONE: Execute Copy Trade !!! ---
            console.log(`   Action: Triggering copy trade for target wallet ${targetWalletKeyPair.publicKey.toBase58()}`);
            await executeCopyTrade(inputTokenMint, outputTokenMint, inputAmount, outputAmount);

        } else {
             const inputDisplay = inputTokenMint ? (inputTokenMint === SOL_MINT_ADDRESS ? "SOL" : inputTokenMint) : "null";
             const outputDisplay = outputTokenMint ? (outputTokenMint === SOL_MINT_ADDRESS ? "SOL" : outputTokenMint) : "null";
             console.log(`[${signature}] Could not definitively determine swap details from combined SOL and token balances.`);
             console.log(`   Debug Info: Input: ${inputAmount} ${inputDisplay}, Output: ${outputAmount} ${outputDisplay}`);
             // console.log("   Debug Meta:", JSON.stringify(tx.meta, null, 2)); // Uncomment for detailed meta debugging
        }

    } catch (error) {
        // Handle potential rate limits or RPC errors when fetching transactions
        if (error.message.includes('429') || error.message.includes('rate limit')) {
             console.warn(`[${signature}] Rate limited or RPC error fetching transaction: ${error.message}. Retrying might be needed.`);
        } else if (error.message.includes('Transaction results are not available')) {
             console.warn(`[${signature}] Transaction results not available yet. Node might be lagging.`);
        } else if (error.message.includes('Failed to fetch transaction')) {
             console.warn(`[${signature}] Failed to fetch transaction, potentially invalid signature or RPC issue: ${error.message}`);
        }
         else {
            console.error(`[${signature}] Error processing transaction:`, error);
            // Log the full error object for more details if available
             if (error.stack) {
                 console.error(error.stack);
             }
        }
    }
}

// --- Jupiter API Interaction and Trade Execution ---
async function executeCopyTrade(inputMintStr, outputMintStr, sourceInputAmount, sourceOutputAmount) {
    const inputDisplay = inputMintStr === SOL_MINT_ADDRESS ? "SOL" : inputMintStr;
    const outputDisplay = outputMintStr === SOL_MINT_ADDRESS ? "SOL" : outputMintStr;
    console.log(`Attempting copy trade: ${inputDisplay} -> ${outputDisplay}`);

    // --- TODO: Add Value Check (requires fetching token prices) ---
    // Fetch prices for input/output tokens (e.g., using Jupiter Price API or Birdeye)
    // Calculate trade value in USD
    // const tradeValueUSD = await calculateTradeValue(inputMintStr, inputAmount); // Implement this function
    // if (tradeValueUSD < MIN_TRADE_VALUE_USD) {
    //    console.log(`   Trade value $${tradeValueUSD.toFixed(2)} below minimum $${MIN_TRADE_VALUE_USD}. Skipping copy.`);
    //    return;
    // } else {
    //      console.log(`   Trade value: $${tradeValueUSD.toFixed(2)}`);
    // }

    // --- TODO: Calculate Target Trade Amount ---
    // IMPORTANT: Replace this with your desired logic!
    // This example uses a fixed small amount - needs adjustment based on TRADE_PROPORTION, sourceInputAmount, prices etc.
    // Example: Proportion of source input amount (needs token decimals)
    // const targetInputAmount = sourceInputAmount * BigInt(Math.round(TRADE_PROPORTION * 100)) / 100n;
    const targetInputAmount = 10000n; // *** CRITICAL: REPLACE WITH SAFE AND CORRECT LOGIC ***
    console.warn(`   WARNING: Using fixed target input amount: ${targetInputAmount.toString()}. Implement proper calculation!`);
    console.log(`   Target Input Amount (Example): ${targetInputAmount.toString()}`);


    try {
        // 1. Get Quote from Jupiter API
        console.log("   Fetching Jupiter quote...");
        const quoteResponse = await axios.get('https://quote-api.jup.ag/v6/quote', {
            params: {
                inputMint: inputMintStr,
                outputMint: outputMintStr,
                amount: targetInputAmount.toString(), // Amount in lamports/smallest unit
                // slippageBps: 50 // 0.5% slippage (optional)
                // onlyDirectRoutes: false // Consider direct and multi-hop routes
                // asLegacyTransaction: true, // Optional: Use if you have issues with versioned transactions
                 userPublicKey: targetWalletKeyPair.publicKey.toBase58(), // Helps Jupiter optimize routes
            }
        });

        const quote = quoteResponse.data;
        if (!quote || !quote.outAmount) {
             console.error("   Failed to get valid quote from Jupiter API.");
             console.error("   Quote Response:", quoteResponse.data); // Log the raw response
             return;
         }
        console.log(`   Quote received: ${targetInputAmount} ${inputDisplay} -> ${quote.outAmount} ${outputDisplay}`);


        // 2. Get Swap Transaction from Jupiter API
        console.log("   Fetching Jupiter swap transaction...");
        const swapResponse = await axios.post('https://quote-api.jup.ag/v6/swap', {
            quoteResponse: quote,
            userPublicKey: targetWalletKeyPair.publicKey.toBase58(),
            wrapAndUnwrapSol: true, // Automatically handle SOL wrapping/unwrapping
            useSharedAccounts: true, // Simplifies account handling
             dynamicComputeUnitLimit: true, // Let Jupiter recommend compute limit
             computeUnitPriceMicroLamports: 50000, // Example priority fee (adjust based on network conditions)
            // feeAccount: "..." // Optional: specific fee account
        });

        const { swapTransaction } = swapResponse.data;
        if (!swapTransaction) {
             console.error("   Failed to get swap transaction from Jupiter API.");
             console.error("   Swap Response:", swapResponse.data); // Log the raw response
             return;
         }

        // 3. Deserialize and Sign Transaction
        console.log("   Deserializing and signing transaction...");
        const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');

        // Determine if it's a VersionedTransaction or legacy Transaction
        let transaction;
         try {
           // Try deserializing as VersionedTransaction first
           transaction = VersionedTransaction.deserialize(swapTransactionBuf);
           console.log("   Transaction is VersionedTransaction.");
         } catch (e) {
           // Fallback to legacy Transaction if deserialize fails
           try {
                transaction = Transaction.from(swapTransactionBuf);
                console.log("   Transaction is legacy Transaction.");
           } catch (legacyError) {
                console.error("   Failed to deserialize transaction as both Versioned and Legacy.");
                console.error("   Deserialize Versioned Error:", e);
                console.error("   Deserialize Legacy Error:", legacyError);
                return; // Cannot proceed
           }
         }


        // Sign the transaction with the target wallet
        transaction.sign([targetWalletKeyPair]);

        // 4. Send Transaction
        console.log("   Sending transaction...");
        // Use sendRawTransaction for robustness, especially with versioned transactions and priority fees
        const rawTransaction = transaction.serialize();
        const txid = await connection.sendRawTransaction(rawTransaction, {
            skipPreflight: true, // Skip client-side simulation; relies on Jupiter's simulation & priority fees
            maxRetries: 5 // Optional: Retry sending on temporary network issues
        });

        console.log(`   Transaction sent: ${txid}`);

        // 5. Confirm Transaction
        console.log(`   Confirming transaction (may take time)... ${txid}`);
         const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed'); // Use confirmed for confirmation
         const confirmation = await connection.confirmTransaction(
             {
                 signature: txid,
                 blockhash: blockhash,
                 lastValidBlockHeight: lastValidBlockHeight,
             },
             'confirmed' // Or 'finalized' for higher assurance
         );


         if (confirmation.value.err) {
             console.error(`   Transaction ${txid} failed to confirm:`, confirmation.value.err);
         } else {
             console.log(`   Transaction ${txid} confirmed successfully!`);
         }

    } catch (error) {
        console.error(`   Error during copy trade execution:`);
        // Log Axios error details if available
        if (axios.isAxiosError(error)) {
             console.error("   Axios Error:", error.message);
             if (error.response) {
                 console.error("   Status:", error.response.status);
                 console.error("   Data:", JSON.stringify(error.response.data, null, 2));
                  if (error.response.status === 400 && error.response.data?.message) {
                      console.error("   Possible Jupiter API Error:", error.response.data.message);
                  } else if (error.response.data?.error?.message) {
                     console.error("   Possible Jupiter API Error:", error.response.data.error.message);
                  }
             }
         } else {
             // Log generic errors
             console.error("   Non-Axios Error:", error.message);
             if (error.stack) {
                console.error(error.stack);
             }
         }

        console.error("   Possible causes: Insufficient balance in target wallet, invalid token accounts, high slippage, network congestion, or API parameter issues.");
    }
}


// --- Start Monitoring ---
monitorWallet().catch(console.error);

// Basic keep-alive mechanism (optional)
setInterval(() => {
    // console.log("Monitoring active...") // Can be noisy
}, 60000); // Keep alive log every minute
