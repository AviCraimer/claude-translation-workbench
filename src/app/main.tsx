import { render } from "@solidjs/web";
import { connect } from "./platform";
import { App } from "./App";
import "./styles.css";

connect().then(platform => {
  render(() => <App platform={platform} />, document.getElementById("root")!);
});
