/** The bundler injects `import.meta.env`; only the development flag and the public OIDC settings are read here. */
interface ImportMeta {
  readonly env?: {
    readonly DEV?: boolean;
    readonly VITE_OIDC_DOMAIN?: string;
    readonly VITE_OIDC_CLIENT_ID?: string;
  };
}
