import React, { useState } from 'react';
import { projectInitials, type ProjectAppearance } from '../../shared/projectAppearance';

/** Shared by the rail and settings preview, including the missing-image fallback. */
export function ProjectIcon({ name, appearance }: { name: string; appearance: ProjectAppearance }) {
  const [failedImage, setFailedImage] = useState<string>();
  return appearance.imageUrl && failedImage !== appearance.imageUrl
    ? <img className="project-icon-image" src={appearance.imageUrl} alt="" draggable={false}
        onError={() => setFailedImage(appearance.imageUrl)} />
    : <span className="project-icon-initials">{appearance.initials || projectInitials(name)}</span>;
}
