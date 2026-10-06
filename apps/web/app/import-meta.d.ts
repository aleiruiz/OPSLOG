/** The bundler injects `import.meta.env`; only the development flag is read here. */
interface ImportMeta {
  readonly env?: { readonly DEV?: boolean };
}
