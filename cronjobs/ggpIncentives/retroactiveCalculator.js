const ethers = require('ethers');
const {
  dynamoDb,
  fromWei,
  fromBytes32,
  formatUnits,
  avalancheHistoricalProvider,
  getWrappedContractsHistorical,
  getArweavePackages
} = require('../utils/helpers');
const constants = require('../config/constants.json');
const FACTORY = require('../abis/SmartLoansFactory.json');
const EthDater = require("ethereum-block-by-date");
const redstone = require("redstone-api");
const fs = require('fs');

// const config = require("../../src/config");
// const key = fs.readFileSync("./.secret").toString().trim();

// const Web3 = require('web3');
// const fs = require("fs");
const blockTimestampStart = 1725912226;
const blockTimestampEnd = 1727455688;

const factoryAddress = constants.avalanche.factory;

const getBlockForTimestamp = async (timestamp) => {
  const dater = new EthDater(
    avalancheHistoricalProvider // ethers provider, required.
  );

  return await dater.getDate(
    timestamp, // Date, required. Any valid moment.js value: string, milliseconds, Date() object, moment() object.
    true // Block after, optional. Search for the nearest block before or after the given date. By default true.
  );
}

const findClosest = (numbers, target) => {

  let closest = numbers[0];
  // Assume the first number is the closest
  let closestDiff = Math.abs(target - closest.timestamp);

  // Calculate the difference between the target and closest
  for (let i = 1; i < numbers.length; i++) {
    let current = numbers[i];
    let currentDiff = Math.abs(target - current.timestamp);

    // Calculate the difference between the target and current number
    if (currentDiff < closestDiff) {
      closest = current;

      // Update the closest number
      closestDiff = currentDiff;

      // Update the closest difference
    }
  }
  return closest;
}

const ggpIncentivesCalculatorAvaRetroactive = async (event) => {
  //in seconds
  let timestampInSeconds = blockTimestampStart;

  let prices = {};

  const resp = await redstone.getHistoricalPrice('WOMBAT_ggAVAX_AVAX_LP_ggAVAX', {
    startDate: (blockTimestampStart - 60 * 60 * 4) * 1000,
    interval: 60 * 60 * 1000,
    endDate: (blockTimestampEnd + 60 * 60 * 4) * 1000,
    provider: "redstone"
  });

  prices['WOMBAT_ggAVAX_AVAX_LP_ggAVAX'] = resp;
  // incentives of all loans

  while (timestampInSeconds <= blockTimestampEnd) {
    let loanIncentives = {};

    console.log(`Processed timestamp: ${timestampInSeconds}`)
    let packages = await getArweavePackages(timestampInSeconds, "avalanche");
    console.log("Got packages")

    let blockNumber = (await getBlockForTimestamp(timestampInSeconds * 1000)).block;
    console.log("block number: ", blockNumber);
    const factoryContract = new ethers.Contract(factoryAddress, FACTORY.abi, avalancheHistoricalProvider);
    let loanAddresses = await factoryContract.getAllLoans({ blockTag: blockNumber });
    const totalLoans = loanAddresses.length;
    console.log(`${totalLoans} loans found.`);

    const incentivesPerWeek = 125;
    const incentivesPerInterval = incentivesPerWeek / (60 * 60 * 24 * 7) * (60 * 60 * 24);
    const batchSize = 50;

    const loanQualifications = {};
    let totalEligibleTvl = 0;


    for (let i = 0; i < Math.ceil(totalLoans / batchSize); i++) {
      try {
        console.log(`processing ${i * batchSize} - ${(i + 1) * batchSize > totalLoans ? totalLoans : (i + 1) * batchSize} loans. ${timestampInSeconds}`);

        const batchLoanAddresses = loanAddresses.slice(i * batchSize, (i + 1) * batchSize);

        const wrappedContracts = await getWrappedContractsHistorical(batchLoanAddresses, 'avalanche', packages)

        async function runMethod(contract, methodName, blockNumber) {
          const tx = await contract.populateTransaction[methodName]()
          let res = await contract.signer.call(tx, blockNumber)
          return contract.interface.decodeFunctionResult(
            methodName,
            res
          )[0];
        }

        const loanStats = await Promise.all(
          wrappedContracts.map(contract => Promise.all([
            runMethod(contract, 'getFullLoanStatus', blockNumber),
            runMethod(contract, 'ggAvaxBalanceAvaxGgavaxYY', blockNumber)
          ])));


        if (loanStats.length > 0) {
          await Promise.all(
            loanStats.map(async (loan, batchId) => {
              const loanId = batchLoanAddresses[batchId].toLowerCase();
              const status = loan[0];
              const collateral = fromWei(status[0]) - fromWei(status[1]);
      
              const ggAvaxBalance = formatUnits(loan[1]);
              const ggAvaxPrice = findClosest(prices['WOMBAT_ggAVAX_AVAX_LP_ggAVAX'], timestampInSeconds * 1000);
              const loanggAvaxValue = ggAvaxBalance * ggAvaxPrice.value;
              // console.log(loanId, ggAvaxBalance, ggAvaxPrice.value, loanggAvaxValue)
      
              const eligibleTvl = loanggAvaxValue - collateral > 0 ? loanggAvaxValue - collateral : 0;
      
              loanQualifications[loanId] = {
                eligibleTvl
              };
      
              totalEligibleTvl += eligibleTvl;
            })
          );
        }
      } catch (error) {
        console.log(`loan calculation failed. Error: ${error}`);
      }
    }

    console.log(`${Object.entries(loanQualifications).length} loans analyzed.`);


    Object.entries(loanQualifications).map(([loanId, loanData]) => {
      if (loanData.eligibleTvl > 0) {
        const intervalIncentivesForLoan = incentivesPerInterval * loanData.eligibleTvl / totalEligibleTvl;

        if(!loanIncentives[loanId]) {
            loanIncentives[loanId] = intervalIncentivesForLoan;
        } else {
            loanIncentives[loanId] += intervalIncentivesForLoan
        }
      }
    })

    // save/update incentives values to DB
    // await Promise.all(
    //   Object.entries(loanIncentives).map(async ([loanId, value]) => {
    //     const data = {
    //       id: loanId,
    //       timestamp: timestampInSeconds,
    //       avaxCollected: value
    //     };
    //
    //     const params = {
    //       TableName: 'ggp-incentives-ava-prod',
    //       Item: data
    //     };
    //     await dynamoDb.put(params).promise();
    //   })
    // );

    console.log(`GGP incentives updated for timestamp ${timestampInSeconds}.`)

    console.log(`Updated timestamp: ${timestampInSeconds}, block number: ${blockNumber}.`);

    timestampInSeconds += 60 * 60 * 24;
    fs.writeFileSync(`./ggpIncentives_${timestampInSeconds}.json`, JSON.stringify(loanIncentives));
  }
  console.log("GGP incentives calculation completed.");
  // console.log(loanIncentives);
  // let loanIncentivesSum = Object.values(loanIncentives).reduce((a, b) => a + b, 0);
  //   console.log(`Total incentives: ${loanIncentivesSum}`);
  // write to a local JSON with timestamp in filename

}

ggpIncentivesCalculatorAvaRetroactive();