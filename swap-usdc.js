const { ethers } = require("ethers");
const fs = require("fs");
const provider = new ethers.providers.JsonRpcProvider("https://polygon-rpc.com");

// Read private key from .env
const envFile = fs.readFileSync("/opt/polymarket-trading/.env", "utf8");
const match = envFile.match(/PRIVATE_KEY=(.+)/);
const key = match ? match[1].trim() : "";
if (!key) { console.error("No PRIVATE_KEY found"); process.exit(1); }

const wallet = new ethers.Wallet(key, provider);
const USDC_NATIVE = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const USDC_BRIDGED = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)"];
const ROUTER_ABI = ["function exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160)) payable returns (uint256)"];

async function main() {
  const native = new ethers.Contract(USDC_NATIVE, ERC20_ABI, wallet);
  const bridged = new ethers.Contract(USDC_BRIDGED, ERC20_ABI, wallet);

  const bal = await native.balanceOf(wallet.address);
  console.log("Native USDC balance:", ethers.utils.formatUnits(bal, 6));
  if (bal.isZero()) { console.log("No native USDC to swap"); return; }

  const allowance = await native.allowance(wallet.address, ROUTER);
  if (allowance.lt(bal)) {
    console.log("Approving router...");
    const tx = await native.approve(ROUTER, ethers.constants.MaxUint256);
    await tx.wait();
    console.log("Approved");
  }

  const router = new ethers.Contract(ROUTER, ROUTER_ABI, wallet);
  const deadline = Math.floor(Date.now() / 1000) + 600;
  console.log("Swapping", ethers.utils.formatUnits(bal, 6), "USDC -> USDC.e ...");
  const tx = await router.exactInputSingle({
    tokenIn: USDC_NATIVE,
    tokenOut: USDC_BRIDGED,
    fee: 100,
    recipient: wallet.address,
    deadline,
    amountIn: bal,
    amountOutMinimum: bal.mul(99).div(100),
    sqrtPriceLimitX96: 0
  }, { gasLimit: 300000 });
  const receipt = await tx.wait();
  console.log("Swap done! TX:", receipt.transactionHash);

  const newBal = await bridged.balanceOf(wallet.address);
  console.log("New USDC.e balance:", ethers.utils.formatUnits(newBal, 6));
}
main().catch(e => console.error("Error:", e.message));
