const solanaWeb3 = require('@solana/web3.js');
const { OpenOrders } = require('@project-serum/serum');
const BN = require('bignumber.js');

const connection = new solanaWeb3.Connection(
  "https://solana-api.projectserum.com"
);

const {
  VAULT_LAYOUT,
  ORCA_VAULT_LAYOUT,
  MINT_LAYOUT,
  LENDING_OBLIGATION_LAYOUT,
  AMM_INFO_LAYOUT_V4,
  USD_UNIT,
  ETH_UNIT
} = require("./config");

const {
  getAccountInfo,
  b58AddressToPubKey,
} = require('./utils');

/**
 *
 * @param {Authority address} authority base58
 * @param {Solfarm leveraged address } programId base58
 * @param {0 as of now} index number
 * @param {farm IDs as show on FARM object} farm number
 * @returns
 */
const findUserFarmAddress = async (
  authority,
  programId,
  index,
  farm,
) => {

  /**
   * Create buffer arrays for index (always 0)
   * and _farm first byte with proper IDs, then fill with 0s
   */
  const _index = Buffer.alloc(8, index.toNumber());
  let _farm = Buffer.alloc(8);
  _farm[0] = farm;

  try {
    let seeds = [
      authority.toBuffer(),
      _index,
      _farm
    ];

    let k = await solanaWeb3.PublicKey.findProgramAddress(seeds, programId);

    return k;
  } catch (error) {
    throw (error);
  }

}

/**
 *
 * @param {Authority address} authority base58
 * @param {Address found with findProgramAddress } userFarmAddr base58
 * @param {Leverage programid } programId
 * @param {index obligation on USER_FARM} obligationIndex
 * @returns
 */
const findUserFarmObligationAddress = async (
  authority,
  userFarmAddr,
  programId,
  obligationIndex
) => {
  try {

    let _obligationIndex = Buffer.alloc(8);
    _obligationIndex[0] = obligationIndex;

    const seeds = [
      authority.toBuffer(),
      userFarmAddr.toBuffer(),
      _obligationIndex
    ];

    return solanaWeb3.PublicKey.findProgramAddress(seeds, programId);

  } catch (error) {
    throw (error);
  }
};


/**
 * Fetches and decodes the VAULT data to return;
 * @param {Address of the Vault to decode} _vaultAddress BASE58
 * @param {VAULT instructions to decode} _INSTRUCTIONS BORSH/struct
 * @returns
 */
const getVaultData = async (_vaultAddress, _INSTRUCTIONS) => {

  try {

    const vaultAddress = b58AddressToPubKey(_vaultAddress);

    const { data } = await connection.getAccountInfo(vaultAddress);

    let vaultData = _INSTRUCTIONS.decode(Buffer.from(data, "base64"));

    return vaultData;

  } catch (error) {
    throw (error);
  }

};

/**
 * This returns the LP amount of the user converting VaultShares to LP tokens.
 * @param {Pool 0 (Raydium) | 1 (Orca)} _poolVault Number
 * @param {vaultShares fetched with LENDING_OBLIGATION_LAYOUT.decode} _userVaultShares
 * @param {Pool Account as seen here: https://gist.github.com/therealssj/c6049ac59863df454fb3f4ff19b529ee} _vaultAddress address
 * @returns
 */
const getDepositedLpTokens = async (_poolVault, _userVaultShares, _vaultAddress) => {

  try {

    let layout = _poolVault == 0 ? VAULT_LAYOUT : ORCA_VAULT_LAYOUT;

    let {
      total_vault_balance,
      total_vlp_shares
    } = await getVaultData(_vaultAddress, layout);

    let lpTokens = _userVaultShares.multipliedBy(total_vault_balance).div(total_vlp_shares);

    return lpTokens;
  } catch (error) {
    console.log(`Error getting depositedLpTokens: ${error}`);
    throw (error);
  }
}
/**
 *
 * @param {address of LP mint of vault} _lpMintAddress base58 encoded
 * @param {address of reserves0} _poolCoinTokenaccount base58 encoded
 * @param {address of reserves1} _poolPcTokenaccount base58 encoded
 * @returns
 */
const getPoolStatus = async (_lpMintAddress, _poolCoinTokenaccount, _poolPcTokenaccount) => {

  try {

    let result;
    result = await connection.getAccountInfo(b58AddressToPubKey(_lpMintAddress));

    let mintData = MINT_LAYOUT.decode(Buffer.from(result.data, "base64"));

    const totalSupply = new BN(mintData.supply);
    const supplyDecimals = mintData.decimals;

    result = await connection.getTokenAccountBalance(b58AddressToPubKey(_poolCoinTokenaccount));

    const coinBalance = new BN(result.value.amount);
    const coinDecimals = new BN(10 ** result.value.decimals);

    result = await connection.getTokenAccountBalance(b58AddressToPubKey(_poolPcTokenaccount));
    const pcBalance = new BN(result.value.amount);
    const pcDecimals = new BN(10 ** result.value.decimals);

    return {
      totalSupply,
      supplyDecimals,
      coinBalance,
      coinDecimals,
      pcBalance,
      pcDecimals
    };

  } catch (error) {
    throw (error);
  }
};

/**
 *
 * @param {Farm pool index on FARM object} _farmIndex number
 * @param {Array position on USER_FARM} _obligationIndex number
 * @param {Solfarm Program ID} _farmProgramId address
 * @param {Pool vault Ray:0 | Orca:1 } _poolVault number
 * @param {Pool Vault address} _vaultAddress address
 * @param {Address of user to check balances} _userAddress address
 * @param {AMM program id} _ammId address
 * @param {Open orders program id} _ammOpenOrders address
 * @param {Address of LP Mint programm} _lpMintAddress address
 * @param {Address of reserves0 token} _poolCoinTokenAccount address
 * @param {Address of reserves1 token} _poolPcTokenAccount address
 * @param {reserve0 usd price} _reserve0Price number
 * @param {reserve1 usd price} _reserve1Price number
 * @returns
 */
const getSolFarmPoolInfo = async (
  _farmIndex,
  _obligationIndex,
  _farmProgramId,
  _poolVault,
  _vaultAddress,
  _userAddress,
  _ammId,
  _ammOpenOrders,
  _lpMintAddress,
  _poolCoinTokenAccount,
  _poolPcTokenAccount,
  _reserve0Price,
  _reserve1Price,
) => {

  try {
    /**
     * Information:
     * Vault data: https://gist.github.com/therealssj/c6049ac59863df454fb3f4ff19b529ee
     *
     * coin = base
     * pc = quote
     *
     * User LpTokens * token USD value = virtual value
     * borrowed = obligationBorrowX.borrowedAmountWads
     * virtual value - borrowed  = value
     *
     */

    if (_reserve0Price == undefined || _reserve1Price == undefined)
      throw ("Reserve prices needs to be passed as parameters");

    const FARM_USER_ADDRESS_INDEX = new BN(0);

    let key = await findUserFarmAddress(
      b58AddressToPubKey(_userAddress),
      b58AddressToPubKey(_farmProgramId),
      FARM_USER_ADDRESS_INDEX,
      new BN(_farmIndex)
    );

    let [userObligationAcct1] = await findUserFarmObligationAddress(
      b58AddressToPubKey(_userAddress),
      key[0],
      b58AddressToPubKey(_farmProgramId),
      new BN(_obligationIndex)
    );

    let accountInfo = await getAccountInfo(userObligationAcct1.toBase58());

    if (accountInfo.value == null)
      throw ("No data on user account, check FARM array position (2nd param on getSolFarmPoolInfo())");

    const rawBuffer = accountInfo.value.data[0];

    const dataBuffer = Buffer.from(rawBuffer, "base64");

    const decoded = LENDING_OBLIGATION_LAYOUT.decode(dataBuffer);

    const vaultShares = new BN(decoded.vaultShares.toString());

    const userLpTokens =
      await getDepositedLpTokens(_poolVault, vaultShares, _vaultAddress);

    /**
     * To get Pool information
     * pcBalance = Total reserve0 balances
     * coinBalance = Total reserve1 balances
     * TotalSupply = total supply of minted lp tokens
     *
   */
    let {
      pcBalance,
      pcDecimals,
      coinBalance,
      coinDecimals,
      totalSupply,
      supplyDecimals
    } = await getPoolStatus(_lpMintAddress, _poolCoinTokenAccount, _poolPcTokenAccount);

    let r0Bal;
    let r1Bal;

    /**
     * If we calculate Raydium vaults, we also get AMM circulating supply;
     */
    if (_poolVault == 0) {

      /**
       * To get AMM ID and fetch circulating values.
       */
      let {
        needTakePnlCoin,
        needTakePnlPc
      } = await getVaultData(_ammId, AMM_INFO_LAYOUT_V4);

      /**
       * Get and decode AMM Open Order values
       */
      let OPEN_ORDER_INSTRUCTIONS = OpenOrders.getLayout(b58AddressToPubKey(_ammOpenOrders));

      let {
        baseTokenTotal,
        quoteTokenTotal
      } = await getVaultData(_ammOpenOrders, OPEN_ORDER_INSTRUCTIONS);

      r0Bal =
        coinBalance
          .plus(baseTokenTotal)
          .minus(needTakePnlCoin)

      r1Bal =
        pcBalance
          .plus(quoteTokenTotal)
          .minus(needTakePnlPc)

    } else {

      r0Bal =
        coinBalance
          .div(coinDecimals);

      r1Bal =
        pcBalance
          .div(pcDecimals);

    }

    /*
     * User LpTokens * token USD value = virtual value
     * borrowed = obligationBorrowX.borrowedAmountWads
     * virtual value - borrowed  = value
     *
     * borrow1 = coin
     * borrow2 = pc
    */

    const poolTVL = r0Bal
      .multipliedBy(_reserve0Price)
      .plus(r1Bal.multipliedBy(_reserve1Price));

    const _supplyDecimals = new BN(10 ** supplyDecimals);

    const unitLpValue = poolTVL.div(totalSupply.div(_supplyDecimals));

    const virtualValue = userLpTokens
      .multipliedBy(unitLpValue)
      .div(USD_UNIT);

    let borrow1 = new BN(decoded.obligationBorrowOne.borrowedAmountWads.toString());
    let borrow2 = new BN(decoded.obligationBorrowTwo.borrowedAmountWads.toString());

    const borrow1Decimals = new BN(10 ** decoded.coinDecimals);
    const borrow2Decimals = new BN(10 ** decoded.pcDecimals);

    let borrowed;

    if (!borrow1.isZero()){
      borrowed = borrow1.div(ETH_UNIT).div(borrow1Decimals);
    }else{
      borrowed = borrow2.div(ETH_UNIT).div(borrow2Decimals);
    }

    const borrowValue = borrowed.multipliedBy(_reserve0Price);

    let value = virtualValue
      .minus(borrowValue);

    let vaultInfo = {
      borrowed: borrowed.toNumber(),
      value: value.toNumber(),
      virtualValue: virtualValue.toNumber()
    };

    return vaultInfo;

  } catch (error) {
    throw (error);
  }

};
module.exports = {
  getSolFarmPoolInfo
};

