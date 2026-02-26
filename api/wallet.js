import { Connection, PublicKey } from '@solana/web3.js';

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const WALLET = process.env.BOT_WALLET_PUBLIC || 'CgkZWbNjt4dznALrpbxxZ8ePBmMRwT54wQ1eSUVyGKYw';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

async function getSolPriceUsd() {
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const j = await r.json();
    return Number(j?.solana?.usd || 0);
  } catch {
    return 0;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const conn = new Connection(RPC_URL, 'confirmed');
    const owner = new PublicKey(WALLET);

    const [lamports, tokenAccs, solPrice] = await Promise.all([
      conn.getBalance(owner),
      conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM }),
      getSolPriceUsd(),
    ]);

    const sol = lamports / 1e9;
    let usdc = 0;
    for (const a of tokenAccs.value) {
      const info = a.account.data.parsed.info;
      if (info.mint === USDC_MINT) usdc += Number(info.tokenAmount.uiAmount || 0);
    }

    const totalUsd = usdc + sol * solPrice;

    res.status(200).json({
      wallet: WALLET,
      sol,
      usdc,
      solPriceUsd: solPrice,
      totalUsd,
      timestamp: Date.now(),
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
