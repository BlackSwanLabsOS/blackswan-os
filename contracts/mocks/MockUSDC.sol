// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockUSDC
 * @notice Minimal 6-decimal ERC20 for local Hardhat-network testing only.
 * @dev NOT deployed anywhere real — `simulate.js` instead forks the actual
 *      Base USDC contract via `hardhat_setStorageAt`. This mock exists so
 *      verification scripts (e.g. `scripts/verify_dispute_bond.js`) can run
 *      fully in-process, with no network fork required, and freely `mint()`
 *      to any test account.
 */
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "mUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
