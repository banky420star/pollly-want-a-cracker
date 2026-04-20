const { ethers } = require('ethers');
const provider = new ethers.providers.JsonRpcProvider('https://polygon-rpc.com');
provider.getBalance('0x8da37c6f1e47E1A108e0c94c3ECda2FC9d5De54F').then(b => console.log('POL:', ethers.utils.formatEther(b))).catch(console.error);
const usdc = new ethers.Contract('0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', ['function balanceOf(address) view returns (uint256)'], provider);
usdc.balanceOf('0x8da37c6f1e47E1A108e0c94c3ECda2FC9d5De54F').then(b => console.log('USDC.e:', ethers.utils.formatUnits(b, 6))).catch(console.error);
