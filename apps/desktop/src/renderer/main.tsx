import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { api } from "./api.js";
import "./app.css";
import "./chat.css";
import "./rail.css";
import "./settings.css";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<App api={api} />);
}
