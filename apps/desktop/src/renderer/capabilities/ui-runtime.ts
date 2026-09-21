import { useCallback, useEffect, useMemo, useRef, useState, useId } from "react";
import { jsx, jsxs, Fragment } from "react/jsx-runtime";
import type { CapabilityUiRuntime } from "@deepfield/capability-sdk";
import { Modal } from "../features/industry-research/Modal.js";
import { MarkdownMessage } from "../components/MarkdownMessage.js";
import { UrlPopoverLink, isSafeHttpUrl } from "../components/UrlPopoverLink.js";

/** One binding owned by the renderer; packages never import another React. */
export const capabilityUiRuntime: CapabilityUiRuntime = Object.freeze({
  react: Object.freeze({ useCallback, useEffect, useMemo, useRef, useState, useId }),
  jsx: Object.freeze({ jsx, jsxs, Fragment }),
  Modal, MarkdownMessage, UrlPopoverLink, isSafeHttpUrl,
});
