"use client";

import { useEffect } from "react";

/**
 * Temporary presentation guard while CustomerApp remains a large legacy single-file screen.
 * The API is authoritative and already blocks customer provider/model management. This guard
 * removes the obsolete provider entry point from the rendered customer UI until CustomerApp
 * is split into feature components.
 */
export default function PlatformManagedAiUi() {
  useEffect(() => {
    const reconcile = () => {
      document.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
        const text = (button.textContent || "").trim();
        if (/^AI providers(?:\s*\(\d+\))?$/i.test(text)) {
          button.hidden = true;
          button.setAttribute("aria-hidden", "true");
          button.tabIndex = -1;
        }
      });

      document.querySelectorAll<HTMLElement>("p,.empty").forEach((node) => {
        const text = (node.textContent || "").trim();
        if (text === "Agents combine capabilities, live business data, provider/model routing and versioned behavior prompts.") {
          node.textContent = "Agents combine capabilities, live business data and versioned behavior prompts. AI providers and models are managed by the platform.";
        }
        if (text === "Create an agent after choosing a business, then configure a DEFAULT_CHAT model.") {
          node.textContent = "Create an agent after choosing a business. The platform supplies the AI model automatically.";
        }
      });
    };

    reconcile();
    const observer = new MutationObserver(reconcile);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return null;
}
