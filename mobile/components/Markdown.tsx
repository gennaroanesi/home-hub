// Renders markdown notes on the phone: the tree comes from lib/markdown.ts
// (shared with any other client), this file only maps it to RN views.
// Generic on purpose: week notes use it today; document, shopping-item and
// note bodies (rendered with react-markdown on the web) can reuse it.
//
// Links open with Linking; a link without a scheme is treated as https.
// Checkboxes display only (tick state comes from the text).

import { Fragment, useMemo } from "react";
import { Alert, Linking, Platform, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { parseMarkdown, type MdBlock, type MdInline } from "../../lib/markdown";

const ACCENT = "#735f55";
const MONO = Platform.select({ ios: "Menlo", default: "monospace" });

function openLink(href: string) {
  const url = /^[a-z][a-z0-9+.-]*:/i.test(href) ? href : `https://${href}`;
  Linking.openURL(url).catch(() => Alert.alert("Couldn't open link", url));
}

function Inlines({ nodes }: { nodes: MdInline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.type) {
          case "text":
            return <Fragment key={i}>{n.text}</Fragment>;
          case "bold":
            return (
              <Text key={i} style={styles.bold}>
                <Inlines nodes={n.children} />
              </Text>
            );
          case "italic":
            return (
              <Text key={i} style={styles.italic}>
                <Inlines nodes={n.children} />
              </Text>
            );
          case "code":
            return (
              <Text key={i} style={styles.inlineCode}>
                {n.text}
              </Text>
            );
          case "link":
            return (
              <Text key={i} style={styles.link} onPress={() => openLink(n.href)} accessibilityRole="link">
                <Inlines nodes={n.children} />
              </Text>
            );
        }
      })}
    </>
  );
}

const HEADING_SIZES: Record<number, number> = { 1: 20, 2: 18, 3: 16, 4: 15, 5: 14, 6: 14 };

function Block({ block, textStyle }: { block: MdBlock; textStyle: StyleProp<TextStyle> }) {
  switch (block.type) {
    case "heading":
      return (
        <Text style={[styles.text, textStyle, styles.heading, { fontSize: HEADING_SIZES[block.level], lineHeight: HEADING_SIZES[block.level] + 6 }]} accessibilityRole="header">
          <Inlines nodes={block.children} />
        </Text>
      );
    case "paragraph":
      return (
        <Text style={[styles.text, textStyle]}>
          <Inlines nodes={block.children} />
        </Text>
      );
    case "quote":
      return (
        <View style={styles.quote}>
          <Text style={[styles.text, textStyle, styles.quoteText]}>
            <Inlines nodes={block.children} />
          </Text>
        </View>
      );
    case "code":
      return (
        <View style={styles.codeBlock}>
          <Text style={styles.codeText}>{block.text}</Text>
        </View>
      );
    case "rule":
      return <View style={styles.rule} />;
    case "list":
      return (
        <View style={styles.list}>
          {block.items.map((item, i) => (
            <View key={i} style={[styles.item, { marginLeft: item.depth * 16 }]}>
              {item.checked !== null ? (
                <Ionicons name={item.checked ? "checkbox" : "square-outline"} size={16} color={item.checked ? ACCENT : "#999"} style={styles.checkbox} />
              ) : (
                <Text style={[styles.text, textStyle, styles.marker]}>{item.number !== null ? `${item.number}.` : item.depth % 2 ? "◦" : "•"}</Text>
              )}
              <Text style={[styles.text, textStyle, styles.itemText, item.checked && styles.done]}>
                <Inlines nodes={item.children} />
              </Text>
            </View>
          ))}
        </View>
      );
  }
}

export function Markdown({
  content,
  style,
  textStyle,
}: {
  content: string | null | undefined;
  /** Container style (spacing between blocks is built in). */
  style?: StyleProp<ViewStyle>;
  /** Base text style (size / color) applied to every text block. */
  textStyle?: StyleProp<TextStyle>;
}) {
  const blocks = useMemo(() => parseMarkdown(content), [content]);
  if (!blocks.length) return null;
  return (
    <View style={[styles.root, style]}>
      {blocks.map((b, i) => (
        <Block key={i} block={b} textStyle={textStyle} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 6 },
  text: { fontSize: 14, lineHeight: 20, color: "#333" },
  heading: { fontWeight: "700", color: "#222", marginTop: 2 },
  bold: { fontWeight: "700" },
  italic: { fontStyle: "italic" },
  inlineCode: { fontFamily: MONO, fontSize: 13, backgroundColor: "#f3f1ef" },
  link: { color: ACCENT, textDecorationLine: "underline" },
  quote: { borderLeftWidth: 3, borderLeftColor: "#e0d8d2", paddingLeft: 10 },
  quoteText: { color: "#666" },
  codeBlock: { backgroundColor: "#f3f1ef", borderRadius: 8, padding: 10 },
  codeText: { fontFamily: MONO, fontSize: 12, lineHeight: 17, color: "#333" },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: "#ddd", marginVertical: 4 },
  list: { gap: 3 },
  item: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  marker: { minWidth: 14, color: "#888" },
  checkbox: { marginTop: 2 },
  itemText: { flex: 1 },
  done: { color: "#999", textDecorationLine: "line-through" },
});
