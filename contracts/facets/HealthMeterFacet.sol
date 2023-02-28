// SPDX-License-Identifier: BUSL-1.1
// Last deployed from commit: ;
pragma solidity 0.8.17;

import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@redstone-finance/evm-connector/contracts/data-services/AvalancheDataServiceConsumerBase.sol";
import "../interfaces/ITokenManager.sol";
import "../Pool.sol";

//This path is updated during deployment
import "../lib/local/DeploymentConstants.sol";

contract HealthMeterFacet is AvalancheDataServiceConsumerBase {
    struct AssetPrice {
        bytes32 asset;
        uint256 price;
    }

    /**
      * Returns an array of bytes32[] symbols of debt (borrowable) assets.
    **/
    function _getDebtAssets() internal view returns(bytes32[] memory result) {
        ITokenManager tokenManager = DeploymentConstants.getTokenManager();
        result = tokenManager.getAllPoolAssets();
    }

    /**
      * Returns an array of Asset/Price structs of debt (borrowable) assets.
      * @dev This function uses the redstone-evm-connector
    **/
    function _getDebtAssetsPrices() internal view returns(AssetPrice[] memory result) {
        bytes32[] memory debtAssets = _getDebtAssets();

        uint256[] memory debtAssetsPrices = getOracleNumericValuesFromTxMsg(debtAssets);
        result = new AssetPrice[](debtAssetsPrices.length);

        for(uint i; i<debtAssetsPrices.length; i++){
            result[i] = AssetPrice({
                asset: debtAssets[i],
                price: debtAssetsPrices[i]
            });
        }
    }

    /**
      * Returns an array of Asset/Price structs of enriched (always containing AVAX at index 0) owned assets.
      * @dev This function uses the redstone-evm-connector
    **/
    function _getOwnedAssetsWithNativePrices() internal view returns(AssetPrice[] memory result) {
        bytes32[] memory assetsEnriched = _getOwnedAssetsWithNative();
        uint256[] memory prices = getOracleNumericValuesFromTxMsg(assetsEnriched);

        result = new AssetPrice[](assetsEnriched.length);

        for(uint i; i<assetsEnriched.length; i++){
            result[i] = AssetPrice({
                asset: assetsEnriched[i],
                price: prices[i]
            });
        }
    }

    /**
      * Returns list of owned assets that always included NativeToken at index 0
    **/
    function _getOwnedAssetsWithNative() internal view returns(bytes32[] memory){
        bytes32[] memory ownedAssets = DeploymentConstants.getAllOwnedAssets();
        bytes32 nativeTokenSymbol = DeploymentConstants.getNativeTokenSymbol();

        // If account already owns the native token the use ownedAssets.length; Otherwise add one element to account for additional native token.
        uint256 numberOfAssets = DiamondStorageLib.hasAsset(nativeTokenSymbol) ? ownedAssets.length : ownedAssets.length + 1;
        bytes32[] memory assetsWithNative = new bytes32[](numberOfAssets);

        uint256 lastUsedIndex;
        assetsWithNative[0] = nativeTokenSymbol; // First asset = NativeToken

        for(uint i=0; i< ownedAssets.length; i++){
            if(ownedAssets[i] != nativeTokenSymbol){
                lastUsedIndex += 1;
                assetsWithNative[lastUsedIndex] = ownedAssets[i];
            }
        }
        return assetsWithNative;
    }

    /**
     * Returns current health meter (0% - 100%) associated with the loan
     * @dev This function uses the redstone-evm-connector
     */
    function getHealthMeter() public view returns (uint256) {
        AssetPrice[] memory ownedAssetsPrices = _getOwnedAssetsWithNativePrices();
        AssetPrice[] memory debtAssetsPrices = _getDebtAssetsPrices();

        bytes32 nativeTokenSymbol = DeploymentConstants.getNativeTokenSymbol();
        ITokenManager tokenManager = DeploymentConstants.getTokenManager();

        uint256 weightedCollateral = ownedAssetsPrices[0].price * address(this).balance * tokenManager.debtCoverage(tokenManager.getAssetAddress(nativeTokenSymbol, true)) / (10 ** 26);
        uint256 weightedBorrowed = 0;
        uint256 borrowed = 0;

        for (uint256 i = 0; i < ownedAssetsPrices.length; i++) {
            Pool pool = Pool(tokenManager.getPoolAddress(ownedAssetsPrices[i].asset));
            IERC20Metadata token = IERC20Metadata(tokenManager.getAssetAddress(ownedAssetsPrices[i].asset, true));
            uint256 _balance = token.balanceOf(address(this));
            uint256 _borrowed = pool.getBorrowed(address(this));
            if (_balance >= _borrowed) {
                weightedCollateral = weightedCollateral + (ownedAssetsPrices[i].price * (_balance - _borrowed) * tokenManager.debtCoverage(address(token)) / (10 ** token.decimals() * 1e8));
            } else {
                weightedCollateral = weightedCollateral + (ownedAssetsPrices[i].price * (_borrowed - _balance) * tokenManager.debtCoverage(address(token)) / (10 ** token.decimals() * 1e8));
            }
        }

        for (uint256 i = 0; i < debtAssetsPrices.length; i++) {
            if (!DiamondStorageLib.hasAsset(debtAssetsPrices[i].asset)) {
                Pool pool = Pool(tokenManager.getPoolAddress(debtAssetsPrices[i].asset));
                IERC20Metadata token = IERC20Metadata(tokenManager.getAssetAddress(debtAssetsPrices[i].asset, true));
                weightedCollateral = weightedCollateral - (debtAssetsPrices[i].price * pool.getBorrowed(address(this)) * tokenManager.debtCoverage(address(token)) / (10 ** token.decimals() * 1e8));
                weightedBorrowed = weightedBorrowed + (debtAssetsPrices[i].price * pool.getBorrowed(address(this)) * tokenManager.debtCoverage(address(token)) / (10 ** token.decimals() * 1e8));
                borrowed = borrowed + (debtAssetsPrices[i].price * pool.getBorrowed(address(this)) / 1e8);
            }
        }

        uint256 multiplier = 1000;

        if (borrowed == 0) return multiplier;

        if (weightedCollateral > 0 && weightedCollateral + weightedBorrowed > borrowed) {
            return (weightedCollateral + weightedBorrowed - borrowed) * multiplier / weightedCollateral;
        }

        return 0;
    }
}
