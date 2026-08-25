/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Where the API lives, for a build that is not served by the backend. The Serble application id
   * used to sit beside this; it comes from the server now - see services/auth.ts.
   */
  readonly VITE_API_BASE_URL: string | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
