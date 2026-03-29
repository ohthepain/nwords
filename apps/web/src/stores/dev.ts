import { create } from "zustand"
import { persist } from "zustand/middleware"

interface DevState {
	devMode: boolean
	setDevMode: (on: boolean) => void
	toggleDevMode: () => void
}

export const useDevStore = create<DevState>()(
	persist(
		(set) => ({
			devMode: false,
			setDevMode: (devMode) => set({ devMode }),
			toggleDevMode: () => set((s) => ({ devMode: !s.devMode })),
		}),
		{ name: "nwords-dev" },
	),
)
