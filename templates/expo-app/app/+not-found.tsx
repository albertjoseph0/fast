import { Redirect } from "expo-router";

/** Share links (https://<domain><deepLinkPath>) open the app here; send them to the start. */
export default function NotFound() {
  return <Redirect href="/" />;
}
