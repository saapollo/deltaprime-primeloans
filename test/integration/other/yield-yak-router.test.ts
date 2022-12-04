import chai, {expect} from 'chai'
import {ethers, waffle} from 'hardhat'
import {solidity} from "ethereum-waffle";
import {
    PangolinIntermediary,
    SmartLoanGigaChadInterface,
    SmartLoansFactory,
    TokenManager
} from "../../../typechain";
import {SignerWithAddress} from "@nomiclabs/hardhat-ethers/signers";
import TokenManagerArtifact from '../../../artifacts/contracts/TokenManager.sol/TokenManager.json';
import SmartLoansFactoryArtifact from '../../../artifacts/contracts/SmartLoansFactory.sol/SmartLoansFactory.json';
import {
    Asset,
    calculateStakingTokensAmountBasedOnAvaxValue,
    deployAllFacets,
    fromWei,
    getFixedGasSigners,
    recompileConstantsFile,
    toBytes32,
    toWei
} from "../../_helpers";
import {deployDiamond} from '../../../tools/diamond/deploy-diamond';
import {BigNumber, Contract} from "ethers";
import TOKEN_ADDRESSES from "../../../common/addresses/avax/token_addresses.json";
import redstone from "redstone-api";
import {WrapperBuilder} from "@redstone-finance/evm-connector";

const {deployContract} = waffle;
chai.use(solidity);
const {provider} = waffle;
const pangolinRouterAddress = '0xE54Ca86531e17Ef3616d22Ca28b0D458b6C89106';
const yakStakingAVAXTokenAddress = "0xaAc0F2d0630d1D09ab2B5A400412a4840B866d95";
const yakStakingSAVAXTokenAddress = "0xb8f531c0d3c53B1760bcb7F57d87762Fd25c4977";
const erc20ABI = [
    'function decimals() public view returns (uint8)',
    'function balanceOf(address _owner) public view returns (uint256 balance)',
    'function approve(address _spender, uint256 _value) public returns (bool success)',
    'function allowance(address owner, address spender) public view returns (uint256)',
    'function totalSupply() external view returns (uint256)',
    'function totalDeposits() external view returns (uint256)'
]

const wavaxAbi = [
    'function deposit() public payable',
    ...erc20ABI
]

describe('Yield Yak test stake AVAX', () => {
    let smartLoansFactory: SmartLoansFactory,
        loan: SmartLoanGigaChadInterface,
        wrappedLoan: any,
        user: SignerWithAddress,
        owner: SignerWithAddress,
        MOCK_PRICES: any,
        AVAX_PRICE: number,
        YY_AAVE_AVAX_PRICE: number,
        yakStakingContract: Contract,
        avaxTokenContract: Contract;

    before(async () => {
        [user, owner] = await getFixedGasSigners(10000000);
        yakStakingContract = await new ethers.Contract(yakStakingAVAXTokenAddress, erc20ABI, provider);

        let supportedAssets = [
            new Asset(toBytes32('AVAX'), TOKEN_ADDRESSES['AVAX']),
            new Asset(toBytes32('YY_AAVE_AVAX'), TOKEN_ADDRESSES['YY_AAVE_AVAX']),
        ]
        let tokenManager = await deployContract(
            owner,
            TokenManagerArtifact,
            []
        ) as TokenManager;

        await tokenManager.connect(owner).initialize(supportedAssets, []);

        let diamondAddress = await deployDiamond();

        smartLoansFactory = await deployContract(owner, SmartLoansFactoryArtifact) as SmartLoansFactory;
        await smartLoansFactory.initialize(diamondAddress);

        await recompileConstantsFile(
            'local',
            "DeploymentConstants",
            [],
            tokenManager.address,
            diamondAddress,
            smartLoansFactory.address,
            'lib'
        );
        await deployAllFacets(diamondAddress)

        AVAX_PRICE = (await redstone.getPrice('AVAX')).value;
        YY_AAVE_AVAX_PRICE = (await redstone.getPrice('YY_AAVE_AVAX', {provider: "redstone-avalanche-prod-1"})).value;

        MOCK_PRICES = [
            {
                dataFeedId: 'AVAX',
                value: AVAX_PRICE
            },
            {
                dataFeedId: 'YY_AAVE_AVAX',
                value: YY_AAVE_AVAX_PRICE
            },
        ];

        await smartLoansFactory.connect(user).createLoan();

        const loan_proxy_address = await smartLoansFactory.getLoanForOwner(user.address);
        loan = await ethers.getContractAt("SmartLoanGigaChadInterface", loan_proxy_address, user);

        wrappedLoan = WrapperBuilder
            // @ts-ignore
            .wrap(loan)
            .usingSimpleNumericMock({
                mockSignersCount: 10,
                dataPoints: MOCK_PRICES,
            });

        avaxTokenContract = new ethers.Contract(TOKEN_ADDRESSES['AVAX'], wavaxAbi, provider);
        await avaxTokenContract.connect(user).deposit({value: toWei('1000')});
        await avaxTokenContract.connect(user).approve(loan.address, toWei('1000'));
        await wrappedLoan.fund(toBytes32("AVAX"), toWei("100"));
    })

    it("should successfully stake AVAX with YieldYak", async () => {
        let initialAvaxBalance = BigNumber.from(await avaxTokenContract.balanceOf(wrappedLoan.address));
        let initialStakedBalance = await yakStakingContract.balanceOf(wrappedLoan.address);
        let investedAvaxAmount = BigNumber.from(toWei("10"));

        expect(initialStakedBalance).to.be.equal(0);
        expect(fromWei(initialAvaxBalance)).to.be.greaterThan(0);

        await wrappedLoan.stakeAVAXYak(investedAvaxAmount);

        let expectedAfterStakingStakedBalance = await calculateStakingTokensAmountBasedOnAvaxValue(yakStakingContract, investedAvaxAmount);

        let afterStakingStakedBalance = await yakStakingContract.balanceOf(wrappedLoan.address);
        let avaxBalanceDifference = initialAvaxBalance.sub(await avaxTokenContract.balanceOf(wrappedLoan.address));

        expect(afterStakingStakedBalance).to.be.equal(expectedAfterStakingStakedBalance);
        expect(fromWei(avaxBalanceDifference)).to.be.closeTo(10, 1);
    });


    it("should unstake remaining AVAX", async () => {
        let initialAvaxBalance = BigNumber.from(await avaxTokenContract.balanceOf(wrappedLoan.address));
        let initialStakedBalance = await yakStakingContract.balanceOf(wrappedLoan.address);

        await yakStakingContract.connect(user).approve(wrappedLoan.address, initialStakedBalance)
        await wrappedLoan.unstakeAVAXYak(initialStakedBalance);

        let afterUntakingStakedBalance = await yakStakingContract.balanceOf(wrappedLoan.address);
        let avaxBalanceDifference = (await avaxTokenContract.balanceOf(wrappedLoan.address)).sub(initialAvaxBalance);

        expect(afterUntakingStakedBalance).to.be.equal(0);
        expect(fromWei(avaxBalanceDifference)).to.be.closeTo(10, 0.5);
    });

});

describe('Yield Yak test stake sAVAX', () => {
    let smartLoansFactory: SmartLoansFactory,
        loan: SmartLoanGigaChadInterface,
        exchange: PangolinIntermediary,
        wrappedLoan: any,
        user: SignerWithAddress,
        owner: SignerWithAddress,
        MOCK_PRICES: any,
        AVAX_PRICE: number,
        SAVAX_PRICE: number,
        YY_PTP_sAVAX_PRICE: any,
        yakStakingContract: Contract,
        sAvaxTokenContract: Contract,
        avaxTokenContract: Contract;

    before(async () => {
        [user, owner] = await getFixedGasSigners(10000000);
        yakStakingContract = await new ethers.Contract(yakStakingSAVAXTokenAddress, erc20ABI, provider);

        let supportedAssets = [
            new Asset(toBytes32('AVAX'), TOKEN_ADDRESSES['AVAX']),
            new Asset(toBytes32('sAVAX'), TOKEN_ADDRESSES['sAVAX']),
            new Asset(toBytes32('YY_PTP_sAVAX'), TOKEN_ADDRESSES['YY_PTP_sAVAX']),
        ]
        let tokenManager = await deployContract(
            owner,
            TokenManagerArtifact,
            []
        ) as TokenManager;

        await tokenManager.connect(owner).initialize(supportedAssets, []);

        let diamondAddress = await deployDiamond();

        smartLoansFactory = await deployContract(owner, SmartLoansFactoryArtifact) as SmartLoansFactory;
        await smartLoansFactory.initialize(diamondAddress);

        await recompileConstantsFile(
            'local',
            "DeploymentConstants",
            [],
            tokenManager.address,
            diamondAddress,
            smartLoansFactory.address,
            'lib'
        );

        let exchangeFactory = await ethers.getContractFactory("PangolinIntermediary");
        exchange = (await exchangeFactory.deploy()).connect(owner) as PangolinIntermediary;
        await exchange.initialize(pangolinRouterAddress, supportedAssets.map(asset => asset.assetAddress));

        await recompileConstantsFile(
            'local',
            "DeploymentConstants",
            [
                {
                    facetPath: './contracts/facets/avalanche/PangolinDEXFacet.sol',
                    contractAddress: exchange.address,
                }
            ],
            tokenManager.address,
            diamondAddress,
            smartLoansFactory.address,
            'lib'
        );

        await deployAllFacets(diamondAddress)

        // TODO: Include sAVAX and $YYVSAVAXV2 prices once available in redstone
        AVAX_PRICE = (await redstone.getPrice('AVAX', {provider: "redstone-avalanche-prod-1"})).value;
        SAVAX_PRICE = (await redstone.getPrice('sAVAX', {provider: "redstone-avalanche-prod-1"})).value;
        YY_PTP_sAVAX_PRICE = (await redstone.getPrice('YY_PTP_sAVAX', {provider: "redstone-avalanche-prod-1"})).value;

        MOCK_PRICES = [
            {
                dataFeedId: 'AVAX',
                value: AVAX_PRICE
            },
            {
                dataFeedId: 'sAVAX',
                value: SAVAX_PRICE
            },
            {
                dataFeedId: 'YY_PTP_sAVAX',
                value: YY_PTP_sAVAX_PRICE
            },
        ];

        await smartLoansFactory.connect(user).createLoan();

        const loan_proxy_address = await smartLoansFactory.getLoanForOwner(user.address);
        loan = await ethers.getContractAt("SmartLoanGigaChadInterface", loan_proxy_address, user);

        wrappedLoan = WrapperBuilder
            // @ts-ignore
            .wrap(loan)
            .usingSimpleNumericMock({
                mockSignersCount: 10,
                dataPoints: MOCK_PRICES,
            });

        avaxTokenContract = new ethers.Contract(TOKEN_ADDRESSES['AVAX'], wavaxAbi, provider);
        sAvaxTokenContract = new ethers.Contract(TOKEN_ADDRESSES['sAVAX'], wavaxAbi, provider);
        await avaxTokenContract.connect(user).deposit({value: toWei('1000')});
        await avaxTokenContract.connect(user).approve(loan.address, toWei('1000'));
        await wrappedLoan.fund(toBytes32("AVAX"), toWei("100"));
    });

    // TODO: Calculate more accurate expected sAvax output once Redstone data feed provides sAvax price
    it("should buy 50 sAVAX", async () => {
        await wrappedLoan.swapPangolin(
            toBytes32('AVAX'),
            toBytes32('sAVAX'),
            toWei("50"),
            toWei("40")
        )
    });

    it("should successfully stake sAVAX with YieldYak", async () => {
        let initialSAvaxBalance = BigNumber.from(await sAvaxTokenContract.balanceOf(wrappedLoan.address));
        let initialStakedBalance = await yakStakingContract.balanceOf(wrappedLoan.address);
        let investedAvaxAmount = BigNumber.from(toWei("10"));

        expect(initialStakedBalance).to.be.equal(0);
        expect(fromWei(initialSAvaxBalance)).to.be.greaterThan(0);

        await wrappedLoan.stakeSAVAXYak(investedAvaxAmount);

        let expectedAfterStakingStakedBalance = await calculateStakingTokensAmountBasedOnAvaxValue(yakStakingContract, investedAvaxAmount);

        let afterStakingStakedBalance = await yakStakingContract.balanceOf(wrappedLoan.address);
        let sAvaxBalanceDifference = initialSAvaxBalance.sub(await sAvaxTokenContract.balanceOf(wrappedLoan.address));

        expect(fromWei(afterStakingStakedBalance)).to.be.closeTo(fromWei(expectedAfterStakingStakedBalance), 1e-3);
        expect(fromWei(sAvaxBalanceDifference)).to.be.closeTo(10, 1);
    });

    it("should unstake remaining sAVAX", async () => {
        let initialSAvaxBalance = BigNumber.from(await sAvaxTokenContract.balanceOf(wrappedLoan.address));
        let initialStakedBalance = await yakStakingContract.balanceOf(wrappedLoan.address);

        await yakStakingContract.connect(user).approve(wrappedLoan.address, initialStakedBalance)
        await wrappedLoan.unstakeSAVAXYak(initialStakedBalance);

        let afterUntakingStakedBalance = await yakStakingContract.balanceOf(wrappedLoan.address);
        let sAvaxBalanceDifference = (await sAvaxTokenContract.balanceOf(wrappedLoan.address)).sub(initialSAvaxBalance);

        expect(afterUntakingStakedBalance).to.be.equal(0);
        expect(fromWei(sAvaxBalanceDifference)).to.be.closeTo(10, 0.5);
    });

});