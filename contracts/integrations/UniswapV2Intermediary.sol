// SPDX-License-Identifier: UNLICENSED
// Last deployed from commit: c5c938a0524b45376dd482cd5c8fb83fa94c2fcc;
pragma solidity ^0.8.4;

import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router01.sol";
import "@uniswap/lib/contracts/libraries/TransferHelper.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../interfaces/IAssetsExchange.sol";
import "../lib/Bytes32EnumerableMap.sol";
import "../lib/SmartLoanConfigLib.sol";
import "../TokenManager.sol";
import "../TokenList.sol";

/**
 * @title UniswapV2Intermediary
 * @dev Contract allows user to swap ERC20 tokens on DEX
 * This implementation supports UniswapV2Intermediary-like DEXs
 */
contract UniswapV2Intermediary is TokenListOwnableUpgreadable, IAssetsExchange, ReentrancyGuardUpgradeable {
  using TransferHelper for address payable;
  using TransferHelper for address;

  /* ========= STATE VARIABLES ========= */
  IUniswapV2Router01 router;

  function initialize(address _router, address[] memory _whitelistedTokens) external initializer {
    router = IUniswapV2Router01(_router);

    __TokenList_init(_whitelistedTokens);
    __ReentrancyGuard_init();
  }

  /*
   * Swaps selected ERC20 token with other ERC20 token
   * @param soldToken_ sold ERC20 token's address
   * @param boughtToken_ bought ERC20 token's address
   * @param _exactSold exact amount of ERC20 token to be sold
   * @param _minimumBought minimum amount of ERC20 token to be bought
   **/
  function swap(address _soldToken, address _boughtToken, uint256 _exactSold, uint256 _minimumBought) external override nonReentrant returns (uint256[] memory amounts) {
    require(_exactSold > 0, "Amount of tokens to sell has to be greater than 0");

    _soldToken.safeApprove(address(router), 0);
    _soldToken.safeApprove(address(router), _exactSold);

    require(isTokenWhitelisted[_boughtToken], 'Trying to buy unsupported token');

    if (_minimumBought > 0) {
      require(_exactSold >= getMaximumTokensReceived(_minimumBought, _soldToken, _boughtToken), "Not enough funds were provided");
    }

    (bool success, bytes memory result) = address(router).call{value: 0}(
      abi.encodeWithSignature("swapExactTokensForTokens(uint256,uint256,address[],address,uint256)",
      _exactSold, _minimumBought, getPath(_soldToken, _boughtToken), msg.sender, block.timestamp)
    );

    require(success, "Swap was unsuccessful.");

    amounts = abi.decode(result, (uint256[]));

    _soldToken.safeTransfer(msg.sender, IERC20Metadata(_soldToken).balanceOf(address(this)));

    emit TokenSwap(msg.sender, _soldToken, _boughtToken, amounts[0], amounts[amounts.length - 1], block.timestamp);

    return amounts;
  }


  /* ========== RECEIVE AVAX FUNCTION ========== */
  receive() external payable {}


  /* ========== VIEW FUNCTIONS ========== */

  // Initial audit comment: Three below functions can in theory fail if there would be no liquidity at DEX but in this case
  // we can just remove a given asset from supported assets or change all calls to the below functions to an external .call
  // and handle a failure in our code. It is yet to be decided upon.

  /**
   * Returns the minimum _soldToken amount that is required to be sold to receive _exactAmountOut of a _boughtToken.
   **/
  function getMaximumTokensReceived(uint256 _exactAmountOut, address _soldToken, address _boughtToken) public view override returns (uint256) {
    address[] memory path = getPath(_soldToken, _boughtToken);

    return router.getAmountsIn(_exactAmountOut, path)[0];
  }

  /**
   * Returns the maximum _boughtToken amount that will be obtained in the event of selling _amountIn of _soldToken token.
   **/
  function getMinimumTokensNeeded(uint256 _amountIn, address _soldToken, address _boughtToken) public view override returns (uint256) {
    address[] memory path = getPath(_soldToken, _boughtToken);

    return router.getAmountsOut(_amountIn, path)[1];
  }

  /**
   * Returns a path containing tokens' addresses
   * @dev _token ERC20 token's address
   **/
  function getPath(address _token1, address _token2) internal virtual view returns (address[] memory) {
    address[] memory path;

    if (_token1 != getNativeTokenAddress() && _token2 != getNativeTokenAddress()) {
      path = new address[](3);
      path[0] = _token1;
      path[1] = getNativeTokenAddress();
      path[2] = _token2;
    } else {
      path = new address[](2);
      path[0] = _token1;
      path[1] = _token2;
    }

    return path;
  }

  function getNativeTokenAddress() virtual internal view returns (address) {
    return 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
  }

  /* ========== EVENTS ========== */

  /**
   * @dev emitted after tokens were swapped
   * @param seller the address which sold tokens
   * @param soldToken the address of sold token
   * @param boughtToken the address of bought token
   * @param amountSold the amount of token sold
   * @param amountBought the amount of token bought
   **/
  event TokenSwap(address indexed seller, address soldToken, address boughtToken, uint256 amountSold, uint256 amountBought, uint256 timestamp);

}