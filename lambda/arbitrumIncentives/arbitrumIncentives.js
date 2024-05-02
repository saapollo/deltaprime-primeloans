const ethers = require('ethers');
const fetch = require('node-fetch');
const {
  dynamoDb,
  getWrappedContracts,
  fromWei,
  fromBytes32,
  formatUnits,
  arbitrumHistoricalProvider
} = require('../utils/helpers');
const constants = require('../config/constants.json');
const gmTokens = require('../config/gmTokens.json');
const FACTORY = require('../abis/SmartLoansFactory.json');

const factoryAddress = constants.arbitrum.factory;
const redstoneFeedUrl = constants.arbitrum.redstoneFeedUrl;

const arbitrumIncentives = async (event) => {
  const factoryContract = new ethers.Contract(factoryAddress, FACTORY.abi, arbitrumHistoricalProvider);
  let loanAddresses = await factoryContract.getAllLoans();
  const totalLoans = loanAddresses.length;

  const incentivesPerInterval = 225 / (60 * 60 * 24 * 7) * (60 * 10);
  const batchSize = 40;

  const loanQualifications = {};
  let totalLeveragedGM = 0;
  let totalTvl = 0;
  const now = Math.floor(Date.now() / 1000);

  // calculate gm leveraged by the loan
  for (let i = 0; i < Math.ceil(totalLoans/batchSize); i++) {
    console.log(`processing ${i * batchSize} - ${(i + 1) * batchSize > totalLoans ? totalLoans : (i + 1) * batchSize} loans`);

    const batchLoanAddresses = loanAddresses.slice(i * batchSize, (i + 1) * batchSize);
    const wrappedContracts = getWrappedContracts(batchLoanAddresses, 'arbitrum');

    const loanStats = await Promise.all(
      wrappedContracts.map(contract => Promise.all([contract.getFullLoanStatus(), contract.getAllAssetsBalances(), contract.getTotalTraderJoeV2()]))
    );

    const redstonePriceDataRequest = await fetch(redstoneFeedUrl);
    const redstonePriceData = await redstonePriceDataRequest.json();

    if (loanStats.length > 0) {
      await Promise.all(
        loanStats.map(async (loan, batchId) => {
          const loanId = batchLoanAddresses[batchId].toLowerCase();
          const status = loan[0];
          const assetBalances = loan[1];
          const tjv2Prices = loan[2];
          const collateral = fromWei(status[0]) - fromWei(status[1]);

          loanQualifications[loanId] = {
            collateral,
            gmTokens: {},
            loanLeveragedGM: 0
          };

          let loanTotalGMValue = 0;

          await Promise.all(
            Object.entries(gmTokens.arbitrum).map(async ([symbol, token]) => {
              const price = redstonePriceData[symbol] ? redstonePriceData[symbol][0].dataPoints[0].value : 0;

              const asset = assetBalances.find(asset => fromBytes32(asset.name) == symbol);
              const balance = formatUnits(asset.balance.toString(), token.decimals);

              loanQualifications[loanId].gmTokens[symbol] = balance * price;
              loanTotalGMValue += balance * price;
            })
          );

          const loanTotalValue = loanTotalGMValue + formatUnits(tjv2Prices);

          const loanLeveragedGM = loanTotalValue - collateral > 0 ? loanTotalValue - collateral : 0;
          loanQualifications[loanId].loanLeveragedGM = loanLeveragedGM;
          totalLeveragedGM += loanLeveragedGM;
          totalTvl += loanTotalGMValue;
        })
      );
    }
  }

  console.log(`${Object.entries(loanQualifications).length} loans analyzed.`);

  // incentives of all loans
  const loanIncentives = {};

  Object.entries(loanQualifications).map(([loanId, loanData]) => {
    loanIncentives[loanId] = 0;

    if (loanData.loanLeveragedGM > 0) {
      loanIncentives[loanId] = incentivesPerInterval * loanData.loanLeveragedGM / totalLeveragedGM;
    }
  })

  // save/update incentives values to DB
  await Promise.all(
    Object.entries(loanIncentives).map(async ([loanId, value]) => {
      const data = {
        id: loanId,
        timestamp: now,
        arbCollected: value
      };

      const params = {
        TableName: process.env.ARBITRUM_INCENTIVES_ARB_TABLE,
        Item: data
      };
      await dynamoDb.put(params).promise();
    })
  );

  console.log("Arbitrum incentives successfully updated.")

  // save boost APY to DB
  // const boostApy = incentivesPerInterval / totalLeveragedGM * 6 * 24 * 365;
  // const params = {
  //   TableName: process.env.APY_TABLE,
  //   Key: {
  //     id: "GM_BOOST"
  //   },
  //   AttributeUpdates: {
  //     arbApy: {
  //       Value: Number(boostApy) ? boostApy : null,
  //       Action: "PUT"
  //     },
  //     arbTvl: {
  //       Value: Number(totalTvl) ? totalTvl : null,
  //       Action: "PUT"
  //     }
  //   }
  // };

  // await dynamoDb.update(params).promise();

  return event;
}

module.exports.handler = arbitrumIncentives;