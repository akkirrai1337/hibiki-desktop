import { destroyAllPooledWindows, performBrowserFetch, performChallenge } from "../../main/extensions/browserFetchHost";
import { destroyIdleResolverWindows, performBrowserResolve } from "../../main/extensions/browserResolveHost";
import { destroyAllLoginWindows, loginViaWebview } from "../../main/extensions/webLogin";
import type { BrowserPort } from "../types";

/** Hidden BrowserWindows, as the main/extensions/*Host.ts modules run them today. */
export const electronBrowser: BrowserPort = {
  challenge: performChallenge,
  browserFetch: performBrowserFetch,
  resolve: performBrowserResolve,
  login: loginViaWebview,
  dispose() {
    destroyAllPooledWindows();
    destroyIdleResolverWindows();
    destroyAllLoginWindows();
  },
};
