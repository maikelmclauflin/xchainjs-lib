import * as Litecoin from 'bitcoinjs-lib' // https://github.com/bitcoinjs/bitcoinjs-lib
import * as Utils from './utils'
import * as sochain from './sochain-api'
import {
  TxHistoryParams,
  TxsPage,
  Address,
  XChainClient,
  Tx,
  TxParams,
  TxHash,
  Balance,
  Network,
  Fees,
  XChainClientParams,
  BaseXChainClient,
  FeesWithRates,
  FeeRates,
  FeeRate,
} from '@xchainjs/xchain-client'
import { getSeed } from '@xchainjs/xchain-crypto'
import { AssetLTC, assetToBase, assetAmount } from '@xchainjs/xchain-util'
import { NodeAuth } from './types'
import { TxIO } from './types/sochain-api-types'

/**
 * LitecoinClient Interface
 */
interface LitecoinClient {
  getFeesWithRates(memo?: string): Promise<FeesWithRates>
  getFeesWithMemo(memo: string): Promise<Fees>
  getFeeRates(): Promise<FeeRates>
}

export type LitecoinClientParams = XChainClientParams & {
  sochainUrl?: string
  nodeUrl?: string
  nodeAuth?: NodeAuth | null
}

/**
 * Custom Litecoin client
 */
class Client extends BaseXChainClient implements LitecoinClient, XChainClient {
  private sochainUrl = ''
  private nodeUrl = ''
  private nodeAuth?: NodeAuth

  /**
   * Constructor
   * Client is initialised with network type
   * Pass strict null as nodeAuth to disable auth for node json rpc
   *
   * @param {LitecoinClientParams} params
   */
  constructor({
    network = 'testnet',
    sochainUrl = 'https://sochain.com/api/v2',
    phrase,
    nodeUrl,
    nodeAuth = {
      username: 'thorchain',
      password: 'password',
    },
    rootDerivationPaths = {
      mainnet: `m/84'/2'/0'/0/`,
      testnet: `m/84'/1'/0'/0/`,
    },
  }: LitecoinClientParams) {
    super('LTC', { network, rootDerivationPaths, phrase })
    this.nodeUrl = !!nodeUrl
      ? nodeUrl
      : network === 'mainnet'
      ? 'https://ltc.thorchain.info'
      : 'https://testnet.ltc.thorchain.info'

    this.nodeAuth =
      // Leave possibility to send requests without auth info for user
      // by strictly passing nodeAuth as null value
      nodeAuth === null ? undefined : nodeAuth

    this.setSochainUrl(sochainUrl)
  }

  /**
   * Set/Update the sochain url.
   *
   * @param {string} url The new sochain url.
   * @returns {void}
   */
  setSochainUrl = (url: string): void => {
    this.sochainUrl = url
  }

  /**
   * Get the explorer url.
   *
   * @returns {string} The explorer url based on the network.
   */
  getExplorerUrl = (): string => {
    return Utils.isTestnet(this.network) ? 'https://tltc.bitaps.com' : 'https://ltc.bitaps.com'
  }

  /**
   * Get the explorer url for the given address.
   *
   * @param {Address} address
   * @returns {string} The explorer url for the given address based on the network.
   */
  getExplorerAddressUrl = (address: Address): string => {
    return `${this.getExplorerUrl()}/${address}`
  }

  /**
   * Get the explorer url for the given transaction id.
   *
   * @param {string} txID The transaction id
   * @returns {string} The explorer url for the given transaction id based on the network.
   */
  getExplorerTxUrl = (txID: string): string => {
    return `${this.getExplorerUrl()}/${txID}`
  }

  /**
   * Get the current address.
   *
   * Generates a network-specific key-pair by first converting the buffer to a Wallet-Import-Format (WIF)
   * The address is then decoded into type P2WPKH and returned.
   *
   * @returns {Address} The current address.
   *
   * @throws {"Phrase must be provided"} Thrown if phrase has not been set before.
   * @throws {"Address not defined"} Thrown if failed creating account from phrase.
   */
  getAddress = (index = 0): Address => {
    if (index < 0) {
      throw new Error('index must be greater than zero')
    }
    if (this.phrase) {
      const ltcNetwork = Utils.ltcNetwork(this.network)
      const ltcKeys = this.getLtcKeys(this.phrase, index)

      const { address } = Litecoin.payments.p2wpkh({
        pubkey: ltcKeys.publicKey,
        network: ltcNetwork,
      })

      if (!address) {
        throw new Error('Address not defined')
      }
      return address
    }
    throw new Error('Phrase must be provided')
  }

  /**
   * @private
   * Get private key.
   *
   * Private function to get keyPair from the this.phrase
   *
   * @param {string} phrase The phrase to be used for generating privkey
   * @returns {ECPairInterface} The privkey generated from the given phrase
   *
   * @throws {"Could not get private key from phrase"} Throws an error if failed creating LTC keys from the given phrase
   * */
  private getLtcKeys = (phrase: string, index = 0): Litecoin.ECPairInterface => {
    const ltcNetwork = Utils.ltcNetwork(this.network)

    const seed = getSeed(phrase)
    const master = Litecoin.bip32.fromSeed(seed, ltcNetwork).derivePath(this.getFullDerivationPath(index))

    if (!master.privateKey) {
      throw new Error('Could not get private key from phrase')
    }

    return Litecoin.ECPair.fromPrivateKey(master.privateKey, { network: ltcNetwork })
  }

  /**
   * Validate the given address.
   *
   * @param {Address} address
   * @returns {boolean} `true` or `false`
   */
  validateAddress = (address: string): boolean => Utils.validateAddress(address, this.network)

  /**
   * Get the LTC balance of a given address.
   *
   * @param {Address} address By default, it will return the balance of the current wallet. (optional)
   * @returns {Array<Balance>} The LTC balance of the address.
   */
  getBalance = async (address: Address): Promise<Balance[]> => {
    try {
      return Utils.getBalance({
        sochainUrl: this.sochainUrl,
        network: this.network,
        address,
      })
    } catch (e) {
      return Promise.reject(e)
    }
  }

  /**
   * Get transaction history of a given address with pagination options.
   * By default it will return the transaction history of the current wallet.
   *
   * @param {TxHistoryParams} params The options to get transaction history. (optional)
   * @returns {TxsPage} The transaction history.
   */
  getTransactions = async (params?: TxHistoryParams): Promise<TxsPage> => {
    // Sochain API doesn't have pagination parameter
    const offset = params?.offset ?? 0
    const limit = params?.limit || 10
    try {
      const response = await sochain.getAddress({
        sochainUrl: this.sochainUrl,
        network: this.network,
        address: `${params?.address}`,
      })
      const total = response.txs.length
      const transactions: Tx[] = []

      const txs = response.txs.filter((_, index) => offset <= index && index < offset + limit)
      for (const txItem of txs) {
        const rawTx = await sochain.getTx({
          sochainUrl: this.sochainUrl,
          network: this.network,
          hash: txItem.txid,
        })
        const tx: Tx = {
          asset: AssetLTC,
          from: rawTx.inputs.map((i: TxIO) => ({
            from: i.address,
            amount: assetToBase(assetAmount(i.value, Utils.LTC_DECIMAL)),
          })),
          to: rawTx.outputs
            // ignore tx with type 'nulldata'
            .filter((i: TxIO) => i.type !== 'nulldata')
            .map((i: TxIO) => ({ to: i.address, amount: assetToBase(assetAmount(i.value, Utils.LTC_DECIMAL)) })),
          date: new Date(rawTx.time * 1000),
          type: 'transfer',
          hash: rawTx.txid,
        }
        transactions.push(tx)
      }

      const result: TxsPage = {
        total,
        txs: transactions,
      }
      return result
    } catch (error) {
      return Promise.reject(error)
    }
  }

  /**
   * Get the transaction details of a given transaction id.
   *
   * @param {string} txId The transaction id.
   * @returns {Tx} The transaction details of the given transaction id.
   */
  getTransactionData = async (txId: string): Promise<Tx> => {
    try {
      const rawTx = await sochain.getTx({
        sochainUrl: this.sochainUrl,
        network: this.network,
        hash: txId,
      })
      return {
        asset: AssetLTC,
        from: rawTx.inputs.map((i) => ({
          from: i.address,
          amount: assetToBase(assetAmount(i.value, Utils.LTC_DECIMAL)),
        })),
        to: rawTx.outputs.map((i) => ({ to: i.address, amount: assetToBase(assetAmount(i.value, Utils.LTC_DECIMAL)) })),
        date: new Date(rawTx.time * 1000),
        type: 'transfer',
        hash: rawTx.txid,
      }
    } catch (error) {
      return Promise.reject(error)
    }
  }
  /**
   * Get the rates and fees.
   *
   * @param {string} memo The memo to be used for fee calculation (optional)
   * @returns {FeesWithRates} The fees and rates
   */
  getFeesWithRates = async (memo?: string): Promise<FeesWithRates> => {
    let rates: FeeRates | undefined = undefined
    try {
      rates = await this.getFeeRatesFromThorchain()
    } catch (error) {
      console.log(error)
      console.warn(`Error pulling rates from thorchain, will try alternate`)
    }
    rates = await this.getFeeRatesFromSoChain()

    const fees: Fees = {
      type: 'byte',
      fast: Utils.calcFee(rates.fast, memo),
      average: Utils.calcFee(rates.average, memo),
      fastest: Utils.calcFee(rates.fastest, memo),
    }

    return { fees, rates }
  }
  private getFeeRatesFromSoChain = async (): Promise<FeeRates> => {
    const nextBlockFeeRate = await sochain.getSuggestedTxFee()
    const rates: FeeRates = {
      fastest: nextBlockFeeRate * 5,
      fast: nextBlockFeeRate * 1,
      average: nextBlockFeeRate * 0.5,
    }

    return rates
  }

  /**
   * Get the current fees.
   *
   * @returns {Fees} The fees without memo
   */
  getFees = async (): Promise<Fees> => {
    try {
      const { fees } = await this.getFeesWithRates()
      return fees
    } catch (error) {
      return Promise.reject(error)
    }
  }

  /**
   * Get the fees for transactions with memo.
   * If you want to get `Fees` and `FeeRates` at once, use `getFeesAndRates` method
   *
   * @param {string} memo
   * @returns {Fees} The fees with memo
   */
  getFeesWithMemo = async (memo: string): Promise<Fees> => {
    try {
      const { fees } = await this.getFeesWithRates(memo)
      return fees
    } catch (error) {
      return Promise.reject(error)
    }
  }

  /**
   * Get the fee rates for transactions without a memo.
   * If you want to get `Fees` and `FeeRates` at once, use `getFeesAndRates` method
   *
   * @returns {FeeRates} The fee rate
   */
  getFeeRates = async (): Promise<FeeRates> => {
    try {
      const { rates } = await this.getFeesWithRates()
      return rates
    } catch (error) {
      return Promise.reject(error)
    }
  }

  /**
   * Transfer LTC.
   *
   * @param {TxParams&FeeRate} params The transfer options.
   * @returns {TxHash} The transaction hash.
   */
  transfer = async (params: TxParams & { feeRate?: FeeRate }): Promise<TxHash> => {
    try {
      const fromAddressIndex = params?.walletIndex || 0
      const feeRate = params.feeRate || (await this.getFeeRates()).fast
      const { psbt } = await Utils.buildTx({
        ...params,
        feeRate,
        sender: this.getAddress(fromAddressIndex),
        sochainUrl: this.sochainUrl,
        network: this.network,
      })
      const ltcKeys = this.getLtcKeys(this.phrase, fromAddressIndex)
      psbt.signAllInputs(ltcKeys) // Sign all inputs
      psbt.finalizeAllInputs() // Finalise inputs
      const txHex = psbt.extractTransaction().toHex() // TX extracted and formatted to hex

      return await Utils.broadcastTx({
        network: this.network,
        txHex,
        nodeUrl: this.nodeUrl,
        auth: this.nodeAuth,
      })
    } catch (e) {
      return Promise.reject(e)
    }
  }
}

export { Client, Network }
