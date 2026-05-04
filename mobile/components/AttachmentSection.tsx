// Self-loading attachment list/uploader for any homeAttachment parent
// (TASK / EVENT / RESERVATION / TRIP / TRIP_LEG / BILL). Mirrors the
// web AttachmentSection — fetches on mount, lets the user add via
// camera / library / file picker, delete with a confirm. Tapping a
// row opens the file in the in-app Safari sheet (image or PDF).
//
// Auth: the underlying upload-url endpoint is gated by withHomeUserAuth,
// so authedFetch attaches the access token.
//
// Render is intentionally compact — these embed inside form modals
// that already have lots of fields above them.

import { useCallback, useEffect, useState } from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Image,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import * as WebBrowser from "expo-web-browser";

import { getClient } from "../lib/amplify";
import {
  uploadAttachmentFile,
  type AttachmentParentType,
} from "../lib/attachments-upload";
import type { Schema } from "../../amplify/data/resource";

type Attachment = Schema["homeAttachment"]["type"];

const WEB_BASE_URL =
  process.env.EXPO_PUBLIC_WEB_BASE_URL ?? "https://home.cristinegennaro.com";

interface Props {
  parentType: AttachmentParentType;
  parentId: string;
  readOnly?: boolean;
}

export function AttachmentSection({
  parentType,
  parentId,
  readOnly = false,
}: Props) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [caption, setCaption] = useState("");

  const load = useCallback(async () => {
    try {
      const client = getClient();
      const { data } = await client.models.homeAttachment.list({
        filter: { parentId: { eq: parentId } },
        limit: 200,
      });
      setAttachments(
        (data ?? []).slice().sort(
          (a, b) =>
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        )
      );
    } catch {
      setAttachments([]);
    } finally {
      setLoading(false);
    }
  }, [parentId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function pickAndUpload(source: "camera" | "library" | "file") {
    let picked:
      | { uri: string; mimeType: string; fileName: string }
      | null = null;

    if (source === "camera") {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        Alert.alert("Camera permission needed");
        return;
      }
      const res = await ImagePicker.launchCameraAsync({
        mediaTypes: ["images"],
        quality: 0.9,
      });
      if (res.canceled || !res.assets[0]) return;
      const a = res.assets[0];
      picked = {
        uri: a.uri,
        mimeType: a.mimeType ?? "image/jpeg",
        fileName: a.fileName ?? "photo.jpg",
      };
    } else if (source === "library") {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert("Photo library permission needed");
        return;
      }
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        quality: 0.9,
      });
      if (res.canceled || !res.assets[0]) return;
      const a = res.assets[0];
      picked = {
        uri: a.uri,
        mimeType: a.mimeType ?? "image/jpeg",
        fileName: a.fileName ?? "photo.jpg",
      };
    } else {
      const res = await DocumentPicker.getDocumentAsync({
        type: ["application/pdf", "image/*"],
        copyToCacheDirectory: true,
      });
      if (res.canceled || !res.assets[0]) return;
      const a = res.assets[0];
      picked = {
        uri: a.uri,
        mimeType: a.mimeType ?? guessMime(a.name),
        fileName: a.name,
      };
    }

    if (!picked) return;
    setUploading(true);
    try {
      const uploaded = await uploadAttachmentFile({
        uri: picked.uri,
        contentType: picked.mimeType,
        filename: picked.fileName,
        parentType,
        parentId,
      });
      const client = getClient();
      const { errors } = await client.models.homeAttachment.create({
        parentType,
        parentId,
        s3Key: uploaded.s3Key,
        filename: uploaded.filename,
        contentType: uploaded.contentType,
        sizeBytes: uploaded.sizeBytes,
        caption: caption.trim() || undefined,
        uploadedBy: "ui",
      });
      if (errors?.length) throw new Error(errors[0].message);
      setCaption("");
      await load();
    } catch (err) {
      Alert.alert(
        "Upload failed",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setUploading(false);
    }
  }

  function showAddSheet() {
    const options = ["Camera", "Photo library", "File", "Cancel"];
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        { options, cancelButtonIndex: 3 },
        (idx) => {
          if (idx === 0) void pickAndUpload("camera");
          else if (idx === 1) void pickAndUpload("library");
          else if (idx === 2) void pickAndUpload("file");
        }
      );
    } else {
      // Fallback for Android — three buttons in an Alert
      Alert.alert("Attach a file", undefined, [
        { text: "Camera", onPress: () => pickAndUpload("camera") },
        { text: "Photo library", onPress: () => pickAndUpload("library") },
        { text: "File", onPress: () => pickAndUpload("file") },
        { text: "Cancel", style: "cancel" },
      ]);
    }
  }

  function confirmDelete(att: Attachment) {
    Alert.alert(
      `Delete "${att.caption || att.filename}"?`,
      "The DB row is removed. The S3 file is left in place.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              const client = getClient();
              const { errors } = await client.models.homeAttachment.delete({
                id: att.id,
              });
              if (errors?.length) throw new Error(errors[0].message);
              await load();
            } catch (err) {
              Alert.alert(
                "Delete failed",
                err instanceof Error ? err.message : String(err)
              );
            }
          },
        },
      ]
    );
  }

  function openAttachment(att: Attachment) {
    const url = publicUrl(att.s3Key);
    void WebBrowser.openBrowserAsync(url);
  }

  return (
    <View style={styles.container}>
      {loading ? (
        <ActivityIndicator size="small" />
      ) : attachments.length > 0 ? (
        <View style={styles.list}>
          {attachments.map((att) => (
            <Pressable
              key={att.id}
              onPress={() => openAttachment(att)}
              style={styles.row}
            >
              {isImage(att.contentType) ? (
                <Image
                  source={{ uri: publicUrl(att.s3Key) }}
                  style={styles.thumb}
                />
              ) : (
                <View style={[styles.thumb, styles.iconThumb]}>
                  <Ionicons
                    name={fileIconName(att.contentType)}
                    size={18}
                    color="#735f55"
                  />
                </View>
              )}
              <View style={styles.rowMain}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {att.caption || att.filename}
                </Text>
                <Text style={styles.rowMeta} numberOfLines={1}>
                  {att.caption ? `${att.filename} · ` : ""}
                  {formatSize(att.sizeBytes)}
                </Text>
              </View>
              {!readOnly && (
                <Pressable
                  onPress={(e) => {
                    e.stopPropagation();
                    confirmDelete(att);
                  }}
                  hitSlop={8}
                  style={styles.deleteBtn}
                >
                  <Ionicons name="trash-outline" size={16} color="#a44" />
                </Pressable>
              )}
            </Pressable>
          ))}
        </View>
      ) : null}

      {!readOnly && (
        <View style={styles.addRow}>
          <TextInput
            style={styles.captionInput}
            value={caption}
            onChangeText={setCaption}
            placeholder="Caption (optional)"
            placeholderTextColor="#888"
            editable={!uploading}
          />
          <Pressable
            onPress={showAddSheet}
            disabled={uploading}
            style={[styles.addBtn, uploading && styles.addBtnBusy]}
          >
            {uploading ? (
              <ActivityIndicator size="small" color="#735f55" />
            ) : (
              <>
                <Ionicons name="attach" size={14} color="#735f55" />
                <Text style={styles.addBtnText}>Attach</Text>
              </>
            )}
          </Pressable>
        </View>
      )}
    </View>
  );
}

function publicUrl(s3Key: string): string {
  // /api/d/<...key> is a catch-all redirector that maps a path under
  // `home/` to the public S3 URL. We strip the leading "home/" since
  // the redirector adds it back. Each segment is encoded individually
  // so slashes survive but special chars in filenames don't break it.
  const trimmed = s3Key.replace(/^home\//, "");
  const path = trimmed.split("/").map(encodeURIComponent).join("/");
  return `${WEB_BASE_URL}/api/d/${path}`;
}

function isImage(contentType: string | null | undefined): boolean {
  return !!contentType && contentType.startsWith("image/");
}

function fileIconName(
  contentType: string | null | undefined
): keyof typeof Ionicons.glyphMap {
  if (contentType === "application/pdf") return "document-text-outline";
  if (contentType?.startsWith("image/")) return "image-outline";
  return "document-outline";
}

function formatSize(bytes: number | null | undefined): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function guessMime(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "pdf":
      return "application/pdf";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "heic":
    case "heif":
      return "image/heic";
    case "gif":
      return "image/gif";
    default:
      return "application/octet-stream";
  }
}

const styles = StyleSheet.create({
  container: { gap: 6 },
  list: { gap: 4 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 8,
    backgroundColor: "#fafafa",
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#e0e0e0",
  },
  thumb: { width: 36, height: 36, borderRadius: 4, backgroundColor: "#eee" },
  iconThumb: { alignItems: "center", justifyContent: "center" },
  rowMain: { flex: 1 },
  rowTitle: { fontSize: 13, color: "#222", fontWeight: "500" },
  rowMeta: { fontSize: 11, color: "#888", marginTop: 1 },
  deleteBtn: { padding: 6 },

  addRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  captionInput: {
    flex: 1,
    fontSize: 13,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: "#fff",
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ddd",
  },
  addBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#d8c9bf",
    backgroundColor: "#faf6f3",
  },
  addBtnBusy: { opacity: 0.6 },
  addBtnText: { fontSize: 13, color: "#735f55", fontWeight: "500" },
});
