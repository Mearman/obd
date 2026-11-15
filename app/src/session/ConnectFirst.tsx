import { Button } from "../ui";
import { connectFirst } from "./session.css";

/**
 * Says that a section needs a connection and offers the way to make one, at the top of a section whose controls stay visible but disabled.
 *
 * @param needs What in the section needs the connection, completing "Connect first: ... needs an adapter".
 */
export function ConnectFirst({
  needs,
  onConnect,
}: {
  readonly needs: string;
  readonly onConnect: () => void;
}) {
  return (
    <div className={connectFirst} role="note">
      <p>Connect first: {needs} needs an adapter.</p>
      <Button onClick={onConnect}>Open Connection</Button>
    </div>
  );
}
