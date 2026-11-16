// Shared look of the people forms (Contacts, Businesses, Household): the
// same sheet header, labels, inputs and chips the other mobile forms use.

import { StyleSheet } from "react-native";

export const ACCENT = "#735f55";

export const formStyles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f7f7f7" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#ddd",
    backgroundColor: "#fff",
  },
  headerTitle: { fontSize: 16, fontWeight: "600", flexShrink: 1, textAlign: "center", marginHorizontal: 8 },
  cancel: { color: "#888", fontSize: 15 },
  save: { color: ACCENT, fontWeight: "600", fontSize: 15 },
  disabled: { opacity: 0.4 },

  body: { padding: 20, gap: 8, paddingBottom: 60 },
  label: {
    fontSize: 12,
    fontWeight: "600",
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 12,
  },
  hint: { fontSize: 12, color: "#999" },
  input: {
    backgroundColor: "#fff",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ddd",
  },
  multiline: { minHeight: 60, textAlignVertical: "top" },

  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ccc",
    backgroundColor: "#fff",
  },
  chipOn: { backgroundColor: ACCENT, borderColor: ACCENT },
  chipText: { color: "#444", fontSize: 13 },
  chipTextOn: { color: "#fff" },

  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ddd",
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  switchLabel: { fontSize: 15, color: "#222", flex: 1, marginRight: 8 },

  photoBlock: { alignItems: "center", marginTop: 4 },
  photo: { width: 120, height: 120, borderRadius: 60, backgroundColor: "#eee" },
  photoPlaceholder: { alignItems: "center", justifyContent: "center" },
  photoInitial: { fontSize: 48, color: "#fff", fontWeight: "500" },
  photoBtnRow: { flexDirection: "row", gap: 8, marginTop: 10 },
  photoBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ccc",
  },
  photoBtnText: { color: ACCENT, fontWeight: "500", fontSize: 13 },
  uploadingRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 },
  uploadingText: { color: "#666", fontSize: 13 },

  deleteBtn: {
    marginTop: 24,
    paddingVertical: 12,
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#e5c4c4",
  },
  deleteText: { color: "#c44", fontWeight: "500", fontSize: 15 },
});
