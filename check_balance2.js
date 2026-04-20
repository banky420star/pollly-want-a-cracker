const { ethers } = require('ethers');
const provider = new ethers.providers.JsonRpcProvider('https://polygon-bor-rpc.publicnode.com');

async function main() {
  try {
    const b = await provider.getBalance('0x8da37c6f1e47E1A108e0c94c3ECda2FC9d5De54F');
    console.log('Wallet POL:', ethers.utils.formatEther(b));
    const usdc = new ethers.Contract('0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', ['function balanceOf(address) view returns (uint256)'], provider);
    const ub = await usdc.balanceOf('0x8da37c6f1e47E1A108e0c94c3ECda2FC9d5De54F');
    console.log('Wallet USDC.e:', ethers.utils.formatUnits(ub, 6));

    const fb = await provider.getBalance('0x2302703692dfb6d4f7c02cc32a36a6e75cada4d2');
    console.log('Funder POL:', ethers.utils.formatEther(fb));
    const fub = await usdc.balanceOf('0x2302703692dfb6d4f7c02cc32a36a6e75cada4d2');
    console.log('Funder USDC.e:', ethers.utils.formatUnits(fub, 6));
  } catch (e) {
    console.error(e);
  }
}
main();
