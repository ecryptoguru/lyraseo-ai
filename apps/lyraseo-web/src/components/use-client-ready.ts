"use client";

import { useSyncExternalStore } from "react";

// Hydration uses the server snapshot until React has committed its handlers.
const subscribeToClientReady = () => () => {};
const getClientReady = () => true;
const getServerReady = () => false;

export function useClientReady() {
  return useSyncExternalStore(
    subscribeToClientReady,
    getClientReady,
    getServerReady,
  );
}
