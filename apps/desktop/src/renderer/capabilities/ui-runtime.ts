import { useCallback, useEffect, useMemo, useRef, useState, useId } from "react";
import { jsx, jsxs, Fragment } from "react/jsx-runtime";
import { flushSync } from "react-dom";
import { CapabilityInteractionState } from "./interaction-state.js";
import type { CapabilityUiRuntime } from "@deepfield/capability-sdk";
import { Modal } from "../components/Modal.js";
import { MarkdownMessage } from "../components/MarkdownMessage.js";
import { UrlPopoverLink, isSafeHttpUrl } from "../components/UrlPopoverLink.js";

/** Flush the package's visible commit before reporting opened to Main. */
export const createCapabilityInteractionState = () => new CapabilityInteractionState(change => flushSync(change));

/** One binding owned by the renderer; packages never import another React. */
export const capabilityUiRuntime: CapabilityUiRuntime = Object.freeze({
  react: Object.freeze({ useCallback, useEffect, useMemo, useRef, useState, useId }),
  jsx: Object.freeze({ jsx, jsxs, Fragment }),
  Modal, MarkdownMessage, UrlPopoverLink, isSafeHttpUrl,
});
