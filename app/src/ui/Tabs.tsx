import * as RadixTabs from "@radix-ui/react-tabs";
import type { ComponentPropsWithoutRef } from "react";
import { content, list, root, trigger } from "./Tabs.css";

/** The Radix tabs root, styled. Controlled or uncontrolled as Radix defines. */
export function Tabs({ className, ...rest }: ComponentPropsWithoutRef<typeof RadixTabs.Root>) {
  return <RadixTabs.Root className={[root, className].filter(Boolean).join(" ")} {...rest} />;
}

/** The row of tab triggers. Pass a `className` to place it (the shell moves it to the bottom). */
export function TabsList({ className, ...rest }: ComponentPropsWithoutRef<typeof RadixTabs.List>) {
  return <RadixTabs.List className={[list, className].filter(Boolean).join(" ")} {...rest} />;
}

/** One tab trigger. */
export function TabsTrigger(props: ComponentPropsWithoutRef<typeof RadixTabs.Trigger>) {
  return <RadixTabs.Trigger className={trigger} {...props} />;
}

/** The panel a tab shows. */
export function TabsContent(props: ComponentPropsWithoutRef<typeof RadixTabs.Content>) {
  return <RadixTabs.Content className={content} {...props} />;
}
