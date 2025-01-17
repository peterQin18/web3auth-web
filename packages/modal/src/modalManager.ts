import {
  ADAPTER_CATEGORY,
  ADAPTER_EVENTS,
  ADAPTER_STATUS,
  BaseAdapterConfig,
  CustomChainConfig,
  getChainConfig,
  IBaseProvider,
  IProvider,
  log,
  LoginMethodConfig,
  WALLET_ADAPTER_TYPE,
  WALLET_ADAPTERS,
  WalletInitializationError,
  Web3AuthNoModalOptions,
} from "@web3auth/base";
import { CommonJRPCProvider } from "@web3auth/base-provider";
import { Web3AuthNoModal } from "@web3auth/no-modal";
import { getOpenloginDefaultOptions, OpenloginAdapter } from "@web3auth/openlogin-adapter";
import { getAdapterSocialLogins, getUserLanguage, LOGIN_MODAL_EVENTS, LoginModal, OPENLOGIN_PROVIDERS, UIConfig } from "@web3auth/ui";
import type { WalletConnectV2Adapter } from "@web3auth/wallet-connect-v2-adapter";

import { defaultOtherModalConfig } from "./config";
import { AdaptersModalConfig, IWeb3AuthModal, ModalConfig } from "./interface";

export interface Web3AuthOptions extends Web3AuthNoModalOptions {
  /**
   * Config for configuring modal ui display properties
   */
  uiConfig?: Omit<UIConfig, "adapterListener">;

  /**
   * Private key provider for your chain namespace
   */
  privateKeyProvider: IBaseProvider<string>;
}

export class Web3Auth extends Web3AuthNoModal implements IWeb3AuthModal {
  public loginModal: LoginModal;

  readonly options: Web3AuthOptions;

  private modalConfig: AdaptersModalConfig = defaultOtherModalConfig;

  constructor(options: Web3AuthOptions) {
    super(options);
    this.options = { ...options };

    if (!this.options.uiConfig) this.options.uiConfig = {};
    if (!this.options.uiConfig.defaultLanguage) this.options.uiConfig.defaultLanguage = getUserLanguage(this.options.uiConfig.defaultLanguage);
    if (!this.options.uiConfig.mode) this.options.uiConfig.mode = "auto";
    if (!this.coreOptions.privateKeyProvider) throw WalletInitializationError.invalidParams("privateKeyProvider is required");

    this.loginModal = new LoginModal({
      ...this.options.uiConfig,
      adapterListener: this,
    });
    this.subscribeToLoginModalEvents();
  }

  public setModalConfig(modalConfig: AdaptersModalConfig): void {
    super.checkInitRequirements();
    this.modalConfig = modalConfig;
  }

  public async initModal(params?: { modalConfig?: Record<WALLET_ADAPTER_TYPE, ModalConfig> }): Promise<void> {
    super.checkInitRequirements();
    await this.loginModal.initModal();
    const providedChainConfig = this.options.chainConfig;
    // TODO: get stuff from dashboard here
    // merge default adapters with the custom configured adapters.
    const allAdapters = [...new Set([...Object.keys(this.modalConfig.adapters || {}), ...Object.keys(this.walletAdapters)])];

    const adapterConfigurationPromises = allAdapters.map(async (adapterName) => {
      // start with the default config of adapter.
      let adapterConfig = this.modalConfig.adapters?.[adapterName] || {
        label: adapterName,
        showOnModal: true,
        showOnMobile: true,
        showOnDesktop: true,
      };

      // override the default config of adapter if some config is being provided by the user.
      if (params?.modalConfig?.[adapterName]) {
        adapterConfig = { ...adapterConfig, ...params.modalConfig[adapterName] };
      }
      (this.modalConfig.adapters as Record<WALLET_ADAPTER_TYPE, ModalConfig>)[adapterName] = adapterConfig as ModalConfig;

      // check if adapter is configured/added by user and exist in walletAdapters map.
      const adapter = this.walletAdapters[adapterName];
      log.debug("adapter config", adapterName, this.modalConfig.adapters?.[adapterName].showOnModal, adapter);

      // if adapter is not custom configured then check if it is available in default adapters.
      // and if adapter is not hidden by user
      if (!adapter && this.modalConfig.adapters?.[adapterName].showOnModal) {
        // Adapters to be shown on modal should be pre-configured.
        if (adapterName === WALLET_ADAPTERS.OPENLOGIN) {
          const defaultOptions = getOpenloginDefaultOptions();
          const { clientId, useCoreKitKey, chainConfig, web3AuthNetwork, sessionTime, privateKeyProvider } = this.coreOptions;
          const finalChainConfig = {
            ...getChainConfig(providedChainConfig.chainNamespace, this.coreOptions.chainConfig?.chainId),
            ...chainConfig,
          } as CustomChainConfig;
          if (!privateKeyProvider) {
            throw WalletInitializationError.invalidParams("privateKeyProvider is required");
          }
          const finalOpenloginAdapterSettings = {
            ...defaultOptions.adapterSettings,
            clientId,
            network: web3AuthNetwork,
            whiteLabel: this.options.uiConfig,
          };
          if (this.options.uiConfig.uxMode) {
            finalOpenloginAdapterSettings.uxMode = this.options.uiConfig.uxMode;
          }
          const openloginAdapter = new OpenloginAdapter({
            ...defaultOptions,
            clientId,
            useCoreKitKey,
            chainConfig: { ...finalChainConfig },
            adapterSettings: finalOpenloginAdapterSettings,
            sessionTime,
            web3AuthNetwork,
            privateKeyProvider,
          });
          this.walletAdapters[adapterName] = openloginAdapter;
          return adapterName;
        }
        throw WalletInitializationError.invalidParams(`Adapter ${adapterName} is not configured`);
      } else if (adapter?.type === ADAPTER_CATEGORY.IN_APP || adapter?.type === ADAPTER_CATEGORY.EXTERNAL || adapterName === this.cachedAdapter) {
        if (!this.modalConfig.adapters?.[adapterName].showOnModal) return;
        // add client id to adapter, same web3auth client id can be used in adapter.
        // this id is being overridden if user is also passing client id in adapter's constructor.
        this.walletAdapters[adapterName].setAdapterSettings({
          clientId: this.options.clientId,
          sessionTime: this.options.sessionTime,
          web3AuthNetwork: this.options.web3AuthNetwork,
          useCoreKitKey: this.coreOptions.useCoreKitKey,
        });

        // if adapter doesn't have any chainConfig then we will set the chainConfig based of passed chainNamespace
        // and chainNamespace.
        if (!adapter.chainConfigProxy) {
          const chainConfig = {
            ...getChainConfig(providedChainConfig.chainNamespace, this.coreOptions.chainConfig?.chainId),
            ...this.coreOptions.chainConfig,
          } as CustomChainConfig;
          this.walletAdapters[adapterName].setAdapterSettings({ chainConfig });
        }

        if (adapterName === WALLET_ADAPTERS.OPENLOGIN) {
          const openloginAdapter = this.walletAdapters[adapterName] as OpenloginAdapter;
          if (this.coreOptions.privateKeyProvider) {
            if (openloginAdapter.currentChainNamespace !== this.coreOptions.privateKeyProvider.currentChainConfig.chainNamespace) {
              throw WalletInitializationError.incompatibleChainNameSpace(
                "private key provider is not compatible with provided chainNamespace for openlogin adapter"
              );
            }
            openloginAdapter.setAdapterSettings({ privateKeyProvider: this.coreOptions.privateKeyProvider });
          }
          if (this.options.uiConfig?.uxMode) {
            openloginAdapter.setAdapterSettings({ uxMode: this.options.uiConfig.uxMode });
          }
          openloginAdapter.setAdapterSettings({ whiteLabel: this.options.uiConfig });
          if (!openloginAdapter.privateKeyProvider) {
            throw WalletInitializationError.invalidParams("privateKeyProvider is required for openlogin adapter");
          }
        } else if (adapterName === WALLET_ADAPTERS.WALLET_CONNECT_V2) {
          const walletConnectAdapter = this.walletAdapters[adapterName] as WalletConnectV2Adapter;
          walletConnectAdapter.setAdapterSettings({
            adapterSettings: {
              walletConnectInitOptions: {
                // Using a default wallet connect project id for web3auth modal integration
                projectId: "d3c63f19f9582f8ba48e982057eb096b", // TODO: get from dashboard
              },
            },
          });
        }

        return adapterName;
      }
    });

    const adapterNames = await Promise.all(adapterConfigurationPromises);
    const hasInAppWallets = Object.values(this.walletAdapters).some((adapter) => {
      if (adapter.type !== ADAPTER_CATEGORY.IN_APP) return false;
      if (this.modalConfig.adapters?.[adapter.name]?.showOnModal !== true) return false;
      if (!this.modalConfig.adapters?.[adapter.name]?.loginMethods) return true;
      const mergedLoginMethods = getAdapterSocialLogins(
        adapter.name,
        (this.modalConfig.adapters as Record<WALLET_ADAPTER_TYPE, ModalConfig>)[adapter.name]?.loginMethods
      );
      if (Object.values(mergedLoginMethods).some((method: LoginMethodConfig[keyof LoginMethodConfig]) => method.showOnModal)) return true;
      return false;
    });
    log.debug(hasInAppWallets, this.walletAdapters, adapterNames, "hasInAppWallets");

    // Now, initialize the adapters.
    const initPromises = adapterNames.map(async (adapterName) => {
      if (!adapterName) return;
      try {
        const adapter = this.walletAdapters[adapterName];
        // only initialize a external adapter here if it is a cached adapter.
        if (this.cachedAdapter !== adapterName && adapter.type === ADAPTER_CATEGORY.EXTERNAL) {
          return;
        }
        // in-app wallets or cached wallet (being connected or already connected) are initialized first.
        // if adapter is configured then only initialize in app or cached adapter.
        // external wallets are initialized on INIT_EXTERNAL_WALLET event.
        this.subscribeToAdapterEvents(adapter);
        if (adapter.status === ADAPTER_STATUS.NOT_READY) await adapter.init({ autoConnect: this.cachedAdapter === adapterName });
        // note: not adding cachedWallet to modal if it is external wallet.
        // adding it later if no in-app wallets are available.
        if (adapter.type === ADAPTER_CATEGORY.IN_APP) {
          this.initializeInAppWallet(adapterName);
        }
      } catch (error) {
        log.error(error, "error while initializing adapter");
      }
    });

    this.commonJRPCProvider = await CommonJRPCProvider.getProviderInstance({ chainConfig: this.coreOptions.chainConfig as CustomChainConfig });
    this.status = ADAPTER_STATUS.READY;
    await Promise.all(initPromises);

    const hasExternalWallets = allAdapters.some((adapterName) => {
      return this.walletAdapters[adapterName]?.type === ADAPTER_CATEGORY.EXTERNAL && this.modalConfig.adapters?.[adapterName].showOnModal;
    });

    if (hasExternalWallets) {
      this.loginModal.initExternalWalletContainer();
    }

    // variable to check if we have any in app wallets
    // currently all default in app and external wallets can be hidden or shown based on config.
    if (!hasInAppWallets && hasExternalWallets) {
      // if no in app wallet is available then initialize external wallets in modal
      await this.initExternalWalletAdapters(false, { showExternalWalletsOnly: true });
    }
  }

  public async connect(): Promise<IProvider | null> {
    // if (!this.loginModal.initialized) throw new Error("Login modal is not initialized");
    // if already connected return provider
    if (this.connectedAdapterName && this.status === ADAPTER_STATUS.CONNECTED && this.provider) return this.provider;
    this.loginModal.open();
    return new Promise((resolve, reject) => {
      this.once(ADAPTER_EVENTS.CONNECTED, () => {
        return resolve(this.provider);
      });
      this.once(ADAPTER_EVENTS.ERRORED, (err: unknown) => {
        return reject(err);
      });
      this.once(LOGIN_MODAL_EVENTS.MODAL_VISIBILITY, (visibility: boolean) => {
        // modal is closed but user is not connected to any wallet.
        if (!visibility && this.status !== ADAPTER_STATUS.CONNECTED) {
          return reject(new Error("User closed the modal"));
        }
      });
    });
  }

  private async initExternalWalletAdapters(externalWalletsInitialized: boolean, options?: { showExternalWalletsOnly: boolean }): Promise<void> {
    if (externalWalletsInitialized) return;
    const adaptersConfig: Record<string, BaseAdapterConfig> = {};
    Object.keys(this.walletAdapters).forEach(async (adapterName) => {
      const adapter = this.walletAdapters[adapterName];
      if (adapter?.type === ADAPTER_CATEGORY.EXTERNAL) {
        log.debug("init external wallet", this.cachedAdapter, adapterName);
        this.subscribeToAdapterEvents(adapter);
        // we are not initializing cached adapter here as it is already being initialized in initModal before.
        if (this.cachedAdapter === adapterName) {
          return;
        }
        if (adapter.status === ADAPTER_STATUS.NOT_READY) {
          await adapter
            .init({ autoConnect: this.cachedAdapter === adapterName })
            .then(() => {
              adaptersConfig[adapterName] = (this.modalConfig.adapters as Record<WALLET_ADAPTER_TYPE, ModalConfig>)[adapterName];
              this.loginModal.addWalletLogins(adaptersConfig, { showExternalWalletsOnly: !!options?.showExternalWalletsOnly });
              return undefined;
            })
            .catch((error) => log.error(error, "error while initializing adapter"));
        } else if (adapter.status === ADAPTER_STATUS.READY) {
          adaptersConfig[adapterName] = (this.modalConfig.adapters as Record<WALLET_ADAPTER_TYPE, ModalConfig>)[adapterName];
          this.loginModal.addWalletLogins(adaptersConfig, { showExternalWalletsOnly: !!options?.showExternalWalletsOnly });
        }
      }
    });
  }

  private initializeInAppWallet(adapterName: string): void {
    log.info("adapterInitResults", adapterName);
    if (this.walletAdapters[adapterName].type === ADAPTER_CATEGORY.IN_APP) {
      this.loginModal.addSocialLogins(
        adapterName,
        getAdapterSocialLogins(adapterName, (this.modalConfig.adapters as Record<WALLET_ADAPTER_TYPE, ModalConfig>)[adapterName]?.loginMethods),
        this.options.uiConfig?.loginMethodsOrder || OPENLOGIN_PROVIDERS,
        {
          ...this.options.uiConfig,
          loginGridCol: this.options.uiConfig?.loginGridCol || 3,
          primaryButton: this.options.uiConfig?.primaryButton || "socialLogin",
        }
      );
    }
  }

  private subscribeToLoginModalEvents(): void {
    this.loginModal.on(LOGIN_MODAL_EVENTS.LOGIN, async (params: { adapter: WALLET_ADAPTER_TYPE; loginParams: unknown }) => {
      try {
        await this.connectTo<unknown>(params.adapter, params.loginParams);
      } catch (error) {
        log.error(`Error while connecting to adapter: ${params.adapter}`, error);
      }
    });
    this.loginModal.on(LOGIN_MODAL_EVENTS.INIT_EXTERNAL_WALLETS, async (params: { externalWalletsInitialized: boolean }) => {
      await this.initExternalWalletAdapters(params.externalWalletsInitialized);
    });
    this.loginModal.on(LOGIN_MODAL_EVENTS.DISCONNECT, async () => {
      try {
        await this.logout();
      } catch (error) {
        log.error(`Error while disconnecting`, error);
      }
    });
    this.loginModal.on(LOGIN_MODAL_EVENTS.MODAL_VISIBILITY, async (visibility: boolean) => {
      log.debug("is login modal visible", visibility);
      this.emit(LOGIN_MODAL_EVENTS.MODAL_VISIBILITY, visibility);
      const adapter = this.walletAdapters[WALLET_ADAPTERS.WALLET_CONNECT_V2];
      if (adapter) {
        const walletConnectStatus = adapter?.status;
        log.debug("trying refreshing wc session", visibility, walletConnectStatus);
        if (visibility && (walletConnectStatus === ADAPTER_STATUS.READY || walletConnectStatus === ADAPTER_STATUS.CONNECTING)) {
          log.debug("refreshing wc session");

          // refreshing session for wallet connect whenever modal is opened.
          try {
            adapter.connect();
          } catch (error) {
            log.error(`Error while disconnecting to wallet connect in core`, error);
          }
        }
        if (
          !visibility &&
          this.status === ADAPTER_STATUS.CONNECTED &&
          (walletConnectStatus === ADAPTER_STATUS.READY || walletConnectStatus === ADAPTER_STATUS.CONNECTING)
        ) {
          log.debug("this stops wc adapter from trying to reconnect once proposal expires");
          adapter.status = ADAPTER_STATUS.READY;
        }
      }
    });
  }
}
