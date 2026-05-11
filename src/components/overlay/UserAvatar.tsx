"use client";

import { useMemo } from "react";

function labelLetter(name: string) {
  const t = name.trim();
  if (!t) return "?";
  return t[0]!.toUpperCase();
}

function hashHue(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) % 360;
  }
  return h;
}

interface UserAvatarProps {
  name: string;
  imageUrl: string | null;
  size?: number;
  className?: string;
}

/**
 * Square image or circular fallback: soft HSL background + first letter
 * (high-contrast light text for WCAG on mid-dark backdrops).
 */
export default function UserAvatar({
  name,
  imageUrl,
  size = 32,
  className = "",
}: UserAvatarProps) {
  const style = useMemo(() => {
    const h = hashHue(name || "x");
    return {
      width: size,
      height: size,
      fontSize: Math.round(size * 0.4),
      background: `hsl(${h} 35% 38%)`,
      color: "hsl(0 0% 98%)",
    } as const;
  }, [name, size]);

  if (imageUrl) {
    return (
      <img
        className={`user-avatar user-avatar--img ${className}`}
        src={imageUrl}
        width={size}
        height={size}
        alt=""
        loading="lazy"
        decoding="async"
        style={{ width: size, height: size }}
        referrerPolicy="no-referrer"
      />
    );
  }

  return (
    <span
      className={`user-avatar user-avatar--fallback ${className}`}
      style={style}
      aria-hidden
    >
      {labelLetter(name)}
    </span>
  );
}
