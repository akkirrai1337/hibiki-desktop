import { create } from "zustand";
import { persist } from "zustand/middleware";

// Purely local/device profile - there's no account system (mirrors the Android app, which also
// has no login). Name and avatar are just cosmetic and persisted the same way as the rest of the
// app's UI prefs (localStorage), not the SQLite DB - nothing else needs to read them.
interface ProfileState {
  name: string | null;
  avatarDataUrl: string | null;
  setName: (name: string | null) => void;
  setAvatarDataUrl: (avatarDataUrl: string | null) => void;
}

export const useProfileStore = create<ProfileState>()(
  persist(
    (set) => ({
      name: null,
      avatarDataUrl: null,
      setName: (name) => set({ name }),
      setAvatarDataUrl: (avatarDataUrl) => set({ avatarDataUrl }),
    }),
    { name: "hibiki-profile" },
  ),
);
