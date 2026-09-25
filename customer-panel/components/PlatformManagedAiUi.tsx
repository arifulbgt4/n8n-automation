"use client";

import { useEffect } from "react";

/**
 * Transitional presentation/navigation guard while CustomerApp remains a large legacy
 * single-file screen. Feature routes are being split out incrementally; this component
 * keeps the existing sidebar useful without weakening the API boundaries.
 */
export default function PlatformManagedAiUi() {
  useEffect(() => {
    const routeTargets: Array<[string, string]> = [
      ["Data / Catalogs", "/catalogs"],
      ["Media", "/media-library"],
    ];

    const reconcile = () => {
      document.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
        const text = (button.textContent || "").replace(/\s+/g, " ").trim();
        if (/AI providers(?:\s*\(\d+\))?$/i.test(text)) {
          button.hidden = true;
          button.setAttribute("aria-hidden", "true");
          button.tabIndex = -1;
        }

        // Sidebar buttons include an icon glyph before their label (for example
        // "▦Data / Catalogs"), so match the semantic label at the end instead of
        // relying on an exact textContent match.
        const target = routeTargets.find(([label]) => text === label || text.endsWith(label))?.[1];
        if (target && button.dataset.featureRoute !== target) {
          button.dataset.featureRoute = target;
          button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopImmediatePropagation();
            window.location.assign(target);
          }, { capture: true });
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
