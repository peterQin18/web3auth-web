import { SafeEventEmitter } from "@toruslabs/openlogin-jrpc";
import {
  Adapter,
  ADAPTER_NAMESPACES,
  ADAPTER_STATUS,
  ADAPTER_STATUS_TYPE,
  ChainNamespaceType,
  CONNECTED_EVENT_DATA,
  CustomChainConfig,
  getChainConfig,
  IAdapter,
  SafeEventEmitterProvider,
  UserInfo,
  WALLET_ADAPTER_TYPE,
  WALLET_ADAPTERS,
  WalletInitializationError,
  WalletLoginError,
} from "@web3auth/base";
import log from "loglevel";

export interface Web3AuthCoreOptions {
  /**
   * The chain namespace to use. Currently only supports "EIP155" and "SOLANA".
   */
  chainNamespace: ChainNamespaceType;
  /**
   * Numeric chainId for the chainNamespace being used, by default it will be mainnet id for the provided namespace..
   * For ex: it will be ethereum mainnet `1` for "EIP155" and solana mainnet `1` for "SOLANA".
   *
   * @defaultValue mainnnet id of provided chainNamespace
   */
  chainId?: number;
}
const ADAPTER_CACHE_KEY = "Web3Auth-cachedAdapter";
export class Web3AuthCore extends SafeEventEmitter {
  readonly coreOptions: Web3AuthCoreOptions;

  public connectedAdapterName: string | null = null;

  public status: ADAPTER_STATUS_TYPE = ADAPTER_STATUS.NOT_READY;

  public provider: SafeEventEmitterProvider | null = null;

  public cachedAdapter?: string | null;

  protected walletAdapters: Record<string, IAdapter<unknown>> = {};

  constructor(options: Web3AuthCoreOptions) {
    super();
    this.cachedAdapter = window.sessionStorage.getItem(ADAPTER_CACHE_KEY);
    this.coreOptions = options;
    this.subscribeToAdapterEvents = this.subscribeToAdapterEvents.bind(this);
  }

  public async init(): Promise<void> {
    const initPromises = Object.keys(this.walletAdapters).map((adapterName) => {
      this.subscribeToAdapterEvents(this.walletAdapters[adapterName]);
      // if adapter doesn't have any chain config yet thn set it based on provided namespace and chainId.
      // if no chainNamespace or chainId is being provided, it will connect with mainnet.
      if (!this.walletAdapters[adapterName].chainConfigProxy) {
        const chainConfig = getChainConfig(this.coreOptions.chainNamespace, this.coreOptions.chainId) as CustomChainConfig;
        this.walletAdapters[adapterName].setChainConfig(chainConfig);
      }
      return this.walletAdapters[adapterName].init({ autoConnect: this.cachedAdapter === adapterName }).catch((e) => e);
    });
    await Promise.all(initPromises);

    this.status = ADAPTER_STATUS.READY;
  }

  public configureAdapter(adapter: Adapter<unknown>): Web3AuthCore {
    if (this.status === ADAPTER_STATUS.CONNECTING) throw WalletInitializationError.notReady("Already pending connection");
    if (this.status === ADAPTER_STATUS.CONNECTED) throw WalletInitializationError.notReady("Already connected");
    if (this.status === ADAPTER_STATUS.READY)
      throw WalletInitializationError.notReady("Adapter is already initialized, so no more adapters can be added");
    if (this.walletAdapters[WALLET_ADAPTERS.OPENLOGIN] && adapter.name === WALLET_ADAPTERS.CUSTOM_AUTH) {
      throw new Error(
        `Either ${WALLET_ADAPTERS.OPENLOGIN} or ${WALLET_ADAPTERS.CUSTOM_AUTH} can be used, ${WALLET_ADAPTERS.OPENLOGIN} adapter already exists.`
      );
    }
    if (this.walletAdapters[WALLET_ADAPTERS.CUSTOM_AUTH] && adapter.name === WALLET_ADAPTERS.OPENLOGIN) {
      throw new Error(
        `Either ${WALLET_ADAPTERS.OPENLOGIN} or ${WALLET_ADAPTERS.CUSTOM_AUTH} can be used, ${WALLET_ADAPTERS.CUSTOM_AUTH} adapter already exists.`
      );
    }
    const adapterAlreadyExists = this.walletAdapters[adapter.name];
    if (adapterAlreadyExists) throw WalletInitializationError.duplicateAdapterError(`Wallet adapter for ${adapter.name} already exists`);
    const adapterInstance = adapter.adapter();
    if (adapterInstance.adapterNamespace !== ADAPTER_NAMESPACES.MULTICHAIN && adapterInstance.adapterNamespace !== this.coreOptions.chainNamespace)
      throw WalletInitializationError.incompatibleChainNameSpace(
        `This wallet adapter belongs to ${adapterInstance.adapterNamespace} which is incompatible with currently used namespace: ${this.coreOptions.chainNamespace}`
      );
    if (
      adapterInstance.adapterNamespace === ADAPTER_NAMESPACES.MULTICHAIN &&
      adapterInstance.currentChainNamespace &&
      this.coreOptions.chainNamespace !== adapterInstance.currentChainNamespace
    )
      throw WalletInitializationError.incompatibleChainNameSpace(
        `${adapter.name} wallet adapter belongs to ${adapterInstance.currentChainNamespace} which is incompatible with currently used namespace: ${this.coreOptions.chainNamespace}`
      );
    this.walletAdapters[adapter.name] = adapterInstance;
    return this;
  }

  public clearCache() {
    window.sessionStorage.removeItem(ADAPTER_CACHE_KEY);
    this.cachedAdapter = undefined;
  }

  /**
   * Connect to a specific wallet adapter
   * @param walletName - Key of the walletAdapter to use.
   */
  async connectTo<T>(walletName: WALLET_ADAPTER_TYPE, loginParams?: T): Promise<void> {
    if (!this.walletAdapters[walletName])
      throw WalletInitializationError.notFound(`Please add wallet adapter for ${walletName} wallet, before connecting`);
    await this.walletAdapters[walletName].connect(loginParams);
  }

  async logout(): Promise<void> {
    if (this.status !== ADAPTER_STATUS.CONNECTED || !this.connectedAdapterName) throw WalletLoginError.notConnectedError(`No wallet is connected`);
    await this.walletAdapters[this.connectedAdapterName].disconnect();
  }

  async getUserInfo(): Promise<Partial<UserInfo>> {
    log.debug("Getting user info", this.status, this.connectedAdapterName);
    if (this.status !== ADAPTER_STATUS.CONNECTED || !this.connectedAdapterName) throw WalletLoginError.notConnectedError(`No wallet is connected`);
    return this.walletAdapters[this.connectedAdapterName].getUserInfo();
  }

  protected subscribeToAdapterEvents(walletAdapter: IAdapter<unknown>): void {
    walletAdapter.on(ADAPTER_STATUS.CONNECTED, (data: CONNECTED_EVENT_DATA) => {
      this.status = ADAPTER_STATUS.CONNECTED;
      const connectedAd = this.walletAdapters[data.adapter];
      this.provider = connectedAd.provider as SafeEventEmitterProvider;
      this.connectedAdapterName = data.adapter;
      this.cacheWallet(data.adapter);
      this.emit(ADAPTER_STATUS.CONNECTED, { ...data } as CONNECTED_EVENT_DATA);
      log.debug("connected", this.status, this.connectedAdapterName);
    });
    walletAdapter.on(ADAPTER_STATUS.DISCONNECTED, (data) => {
      // get back to ready state for rehydrating.
      this.status = ADAPTER_STATUS.READY;
      this.provider = null;
      this.clearCache();
      this.emit(ADAPTER_STATUS.DISCONNECTED, data);
      log.debug("disconnected", this.status, this.connectedAdapterName);
    });
    walletAdapter.on(ADAPTER_STATUS.CONNECTING, (data) => {
      this.status = ADAPTER_STATUS.CONNECTING;
      this.emit(ADAPTER_STATUS.CONNECTING, data);
      log.debug("connecting", this.status, this.connectedAdapterName);
    });
    walletAdapter.on(ADAPTER_STATUS.ERRORED, (data) => {
      this.status = ADAPTER_STATUS.ERRORED;
      this.emit(ADAPTER_STATUS.ERRORED, data);
      log.debug("errored", this.status, this.connectedAdapterName);
    });
  }

  protected checkInitRequirements(): void {
    if (this.status === ADAPTER_STATUS.CONNECTING) throw WalletInitializationError.notReady("Already pending connection");
    if (this.status === ADAPTER_STATUS.CONNECTED) throw WalletInitializationError.notReady("Already connected");
    if (this.status === ADAPTER_STATUS.READY) throw WalletInitializationError.notReady("Adapter is already initialized");
  }

  private cacheWallet(walletName: string) {
    window.sessionStorage.setItem(ADAPTER_CACHE_KEY, walletName);
    this.cachedAdapter = walletName;
  }
}
