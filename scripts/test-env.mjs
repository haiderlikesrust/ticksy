// Tests never read operator credentials, start mainnet mode or use a live DB.
process.env.DOTENV_CONFIG_PATH = new URL('../tests/.env.unused', import.meta.url).pathname;
for (const name of ['DATABASE_URL', 'TREASURY_PRIVATE_KEY', 'SOLANA_RPC_URL', 'MEMECOIN_MINT', 'OWNER_WALLET', 'FEE_RECIPIENT', 'JUPITER_API_KEY', 'COLLECTOR_CRYPT_API_KEY', 'COLLECTOR_CRYPT_PAYMENT_WALLET']) {
  process.env[name] = '';
}
Object.assign(process.env, {
  MAINNET_ENABLED: 'false', APP_ORIGIN: 'http://localhost:5173',
  TRUST_PROXY_HOPS: '0', DAILY_CAP_USD: '0', GAS_RESERVE_SOL: '0.05', SLIPPAGE_BPS: '100',
});
