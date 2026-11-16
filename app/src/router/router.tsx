import {
  createRootRoute,
  createRoute,
  createRouter,
  type RouterHistory,
} from "@tanstack/react-router";
import type { FunctionComponent } from "react";
import { searchSchema } from "./search";

/** What {@link createAppRouter} takes beyond the page component. */
export interface AppRouterOptions {
  /** The path the app is served under, such as `/obd/`; the root when absent. */
  readonly basepath?: string;
  /** Where the address lives; the browser's own history when absent. */
  readonly history?: RouterHistory;
}

/**
 * The app's router: one route whose component is the whole page, with the active screen and the open Library item held in the validated query, so Back, Forward, a reload and a pasted address all return to the same place.
 *
 * There are no meaningful path routes, because GitHub Pages serves a file for every path and has no fallback for one that does not exist; the query always reaches `index.html`.
 *
 * @param component The page, which reads and changes the query through `useAppLocation`.
 */
export function createAppRouter(component: FunctionComponent, options: AppRouterOptions = {}) {
  const rootRoute = createRootRoute({ validateSearch: searchSchema });
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component });
  // The service worker answers every path under the base with the shell, so a path the app has no route for shows the app too, with the query as it is.
  const anyPathRoute = createRoute({ getParentRoute: () => rootRoute, path: "$", component });
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute, anyPathRoute]),
    ...(options.basepath === undefined ? {} : { basepath: options.basepath }),
    ...(options.history === undefined ? {} : { history: options.history }),
  });
}

/** The router type the app's hooks are written against. */
export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
