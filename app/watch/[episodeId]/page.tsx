"use client";

import { use, useEffect } from "react";
import { usePlayer } from "@/components/player/player-provider";

export default function WatchEpisodePage({ params }: { params: Promise<{ episodeId: string }> }) {
  const { episodeId } = use(params);
  const { play } = usePlayer();

  useEffect(() => {
    if (!episodeId) return;
    void play(Number(episodeId));
  }, [episodeId, play]);

  return null;
}
