"use client";

import { useCallback } from "react";
import { usePrivy } from "@privy-io/react-auth";

/// @notice fetch with the current Privy access token. Team, agent, and treasury
/// routes derive identity from this token, never from request bodies.
export function useAuthFetch() {
  const { getAccessToken } = usePrivy();
  return useCallback(
    async (input: string, init: RequestInit = {}) => {
      const token = await getAccessToken();
      const headers = new Headers(init.headers);
      if (token) headers.set("Authorization", `Bearer ${token}`);
      return fetch(input, { ...init, headers });
    },
    [getAccessToken],
  );
}
