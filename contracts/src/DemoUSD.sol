// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title DemoUSD -- a stand-in stablecoin for the testnet demo
/// @notice Six decimals, like USDC, so "0.005 DUSD" really is half a cent.
///         Anyone can mint: this exists so requesters can fund task pools
///         during a demo without us handing out real money. On mainnet this
///         is replaced by actual USDC and nothing else about TaskPool changes.
contract DemoUSD {
    string public constant name = "Demo USD";
    string public constant symbol = "DUSD";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    error InsufficientBalance();
    error InsufficientAllowance();

    /// @notice Open faucet. Testnet only, obviously.
    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        unchecked {
            balanceOf[to] += amount;
        }
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _transfer(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert InsufficientAllowance();
            unchecked {
                allowance[from][msg.sender] = allowed - amount;
            }
        }
        return _transfer(from, to, amount);
    }

    function _transfer(address from, address to, uint256 amount) private returns (bool) {
        uint256 bal = balanceOf[from];
        if (bal < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = bal - amount;
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
        return true;
    }
}
