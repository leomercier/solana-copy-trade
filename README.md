# Solana Copy Trader Bot

This is a Node.js application designed to monitor a specific Solana wallet for swap transactions executed via the Jupiter V6 aggregator and automatically replicate those trades on a target wallet.

**DISCLAIMER:** Trading cryptocurrencies involves significant risk. This bot interacts with real assets using your private key. **Use this software entirely at your own risk.** It is provided for educational purposes only and is not financial advice. The current implementation uses a **hardcoded small trade amount** for safety during testing and **requires modification** for proportional trading. **Never share your private keys.** Ensure you understand the code and the risks before running it.

## Features

*   Monitors a specified Solana source wallet address for Jupiter V6 swap activity.
*   Detects swaps involving SOL and SPL tokens.
*   Uses the Jupiter V6 API (`/quote` and `/swap` endpoints) to fetch trade routes and construct transactions.
*   Executes copy trades using a specified target wallet's private key.
*   Configurable via environment variables.
*   Basic logging for monitoring activity.

## Prerequisites

*   [Node.js](https://nodejs.org/) (v18 or later recommended)
*   [npm](https://www.npmjs.com/) (usually included with Node.js)
*   A Solana RPC endpoint URL (e.g., from Helius, Triton, QuickNode, or use the public `clusterApiUrl`). Mainnet-beta is required for real trades.
*   A source Solana wallet address to monitor.
*   A target Solana wallet (with its private key) to execute the copy trades. **Ensure this wallet is funded.**

## Setup Instructions

1.  **Clone the Repository (if applicable):**
    If you haven't already, clone the project repository to your local machine or development environment.

2.  **Install Dependencies:**
    Open a terminal in the project directory and run:
    ```bash
    npm install
    ```

3.  **Create `.env` File:**
    Create a file named `.env` in the root of the project directory. This file will store your configuration secrets. **Do not commit this file to version control.** Add the following variables:

    ```dotenv
    # .env file

    # Solana RPC endpoint URL. Use a reliable provider for mainnet.
    # Example for mainnet-beta public RPC (not recommended for heavy use):
    # RPC_URL=https://api.mainnet-beta.solana.com
    # Example using a custom provider:
    RPC_URL=YOUR_SOLANA_RPC_URL_HERE

    # The public key (address) of the Solana wallet you want to monitor and copy trades from.
    SOURCE_WALLET_ADDRESS=SOURCE_WALLET_PUBLIC_KEY_HERE

    # The private key of YOUR wallet that will execute the copy trades.
    # IMPORTANT: Keep this secret and secure! This must be the base58 encoded string.
    TARGET_WALLET_PRIVATE_KEY=YOUR_TARGET_WALLET_PRIVATE_KEY_BS58_HERE

    # --- Optional / Needs Implementation ---
    # Proportion of the source trade value to copy (e.g., 0.1 for 10%).
    # NOTE: The current code DOES NOT fully use this; it uses a hardcoded small amount.
    # TRADE_PROPORTION=0.1

    # Minimum trade value in USD to trigger a copy (e.g., 10).
    # NOTE: This feature is currently COMMENTED OUT in the code.
    # MIN_TRADE_VALUE_USD=10
    ```

4.  **Replace Placeholders:**
    Fill in the actual values for `YOUR_SOLANA_RPC_URL_HERE`, `SOURCE_WALLET_PUBLIC_KEY_HERE`, and `YOUR_TARGET_WALLET_PRIVATE_KEY_BS58_HERE` in the `.env` file.

## Running the Bot

1.  **Using Firebase Studio / IDX:**
    *   Ensure you have completed the Setup steps above within your IDX workspace.
    *   Open a terminal within IDX (usually available at the bottom).
    *   Run the bot using the start script defined in `package.json`:
        ```bash
        npm start
        ```

2.  **Using a Local Terminal:**
    *   Navigate to the project directory in your terminal.
    *   Ensure you have completed the Setup steps.
    *   Run the bot:
        ```bash
        npm start
        ```

The bot will start, log the wallets it's monitoring and targeting, and begin listening for transactions from the source wallet. When a Jupiter swap is detected and processed, it will attempt to execute a copy trade.

## How it Works

1.  **Monitoring:** The script connects to the specified Solana RPC endpoint and subscribes to logs associated with the `SOURCE_WALLET_ADDRESS`.
2.  **Detection:** It filters logs, looking for indicators of transactions involving the Jupiter V6 program ID or swap instructions.
3.  **Transaction Fetching:** When a potential Jupiter transaction is detected via logs, the full transaction details are fetched using its signature.
4.  **Analysis:** The transaction details (including account keys and token balance changes) are analyzed to confirm it's a Jupiter V6 swap and to determine the input and output tokens and amounts for the source wallet.
5.  **Copy Trade Execution:**
    *   **(NEEDS MODIFICATION)** Calculates the amount for the target trade. **Currently hardcoded to `10000` lamports/smallest unit.** This needs to be updated to use `TRADE_PROPORTION` and potentially price data.
    *   Calls the Jupiter `/quote` API to find the best route for the calculated target trade amount.
    *   Calls the Jupiter `/swap` API with the quote response to get a serialized transaction.
    *   Signs the transaction using the `TARGET_WALLET_PRIVATE_KEY`.
    *   Sends the signed transaction to the Solana network.
    *   Confirms the transaction.

## Important Considerations & Limitations

*   **CRITICAL: Hardcoded Trade Amount:** The `executeCopyTrade` function currently uses a fixed `targetInputAmount` of `10000` smallest units (e.g., lamports for SOL). You **MUST** modify the logic to calculate the desired trade amount based on `TRADE_PROPORTION`, source amounts, token prices, and target wallet balance before using it for significant trades.
*   **Minimum Trade Value:** The check for `MIN_TRADE_VALUE_USD` is currently commented out and requires implementing price fetching logic.
*   **Security:** Storing private keys in `.env` files has risks. Consider more secure key management solutions (like hardware wallets or dedicated key management services) for production use cases. Exposing private keys can lead to a complete loss of funds.
*   **RPC Limitations:** Public RPC endpoints have rate limits and can be unreliable. Using a dedicated RPC provider is highly recommended for stability.
*   **Jupiter API:** The bot relies on the Jupiter V6 API. Changes to the API could break the bot.
*   **Transaction Costs:** Copy trades incur Solana network fees and potentially Jupiter platform fees. Ensure the target wallet has enough SOL to cover these costs.
*   **Slippage:** Market price fluctuations between the source trade and the copy trade attempt can lead to different execution prices (slippage). The Jupiter API allows setting slippage tolerance.
*   **Error Handling:** While basic error handling exists, edge cases (e.g., network congestion, specific Jupiter errors, insufficient target funds) might not be fully covered.
*   **Detection Accuracy:** Relying solely on logs and program IDs for detection might miss some trades or incorrectly identify others (though checks on transaction details improve accuracy).

## Contributing

Contributions are welcome! Please feel free to submit pull requests or open issues for bugs, feature requests, or improvements.

---

**Remember to prioritize security and test thoroughly, preferably on devnet or with very small amounts on mainnet, before committing significant capital.**
