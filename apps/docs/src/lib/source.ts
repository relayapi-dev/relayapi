import { loader } from "fumadocs-core/source";
import { docs } from "fumadocs-mdx:collections/server";
import { openapiPlugin } from "fumadocs-openapi/server";
import { icons } from "lucide-react";
import { createElement } from "react";
import { platformIcons } from "@/components/platform-icons";

export const source = loader({
  source: docs.toFumadocsSource(),
  baseUrl: "/",
  plugins: [openapiPlugin()],
  icon(icon) {
    if (!icon) return;
    if (icon in platformIcons) {
      const comp = platformIcons[icon as keyof typeof platformIcons];
      if (comp) return createElement(comp);
    }
    if (icon in icons) {
      const comp = icons[icon as keyof typeof icons];
      if (comp) return createElement(comp);
    }
  },
});
