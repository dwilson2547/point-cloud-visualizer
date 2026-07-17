import fs from 'node:fs';

export interface LaserCalibration {
  laserId: number;
  verticalDegrees: number;
  rotationalDegrees?: number;
  distanceOffsetMeters?: number;
}

interface CalibrationDocument {
  lasers: LaserCalibration[];
}

export function loadCalibrationFile(filePath: string, expectedLaserCount = 32): LaserCalibration[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw) as CalibrationDocument | LaserCalibration[];
  const lasers = Array.isArray(parsed) ? parsed : parsed.lasers;
  if (!Array.isArray(lasers) || lasers.length !== expectedLaserCount) {
    throw new Error(
      `Calibration file must contain exactly ${expectedLaserCount} laser entries`,
    );
  }

  const ordered = [...lasers].sort((a, b) => a.laserId - b.laserId);
  for (let index = 0; index < ordered.length; index += 1) {
    const laser = ordered[index];
    if (laser.laserId !== index) {
      throw new Error(
        `Calibration must contain laserId values 0..${expectedLaserCount - 1} in order; missing ${index}`,
      );
    }
    if (!Number.isFinite(laser.verticalDegrees)) {
      throw new Error(`Laser ${laser.laserId} is missing a finite verticalDegrees value`);
    }
    if (
      laser.rotationalDegrees !== undefined &&
      !Number.isFinite(laser.rotationalDegrees)
    ) {
      throw new Error(`Laser ${laser.laserId} has an invalid rotationalDegrees value`);
    }
    if (
      laser.distanceOffsetMeters !== undefined &&
      !Number.isFinite(laser.distanceOffsetMeters)
    ) {
      throw new Error(`Laser ${laser.laserId} has an invalid distanceOffsetMeters value`);
    }
  }

  return ordered;
}
