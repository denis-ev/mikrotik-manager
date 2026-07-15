import {
  majorOf, npkFileName, npkUrl, extraPackageFileName,
  compareRosVersions, isDowngrade, extraEnabledPackages,
} from '../routerosPackages';

describe('majorOf', () => {
  it('extracts the leading major integer', () => {
    expect(majorOf('7.15.3')).toBe(7);
    expect(majorOf('6.49.10')).toBe(6);
    expect(majorOf('7.16beta4')).toBe(7);
  });
  it('returns 0 for unparseable input', () => {
    expect(majorOf('abc')).toBe(0);
  });
});

describe('npkFileName', () => {
  it('puts version before arch on v7+', () => {
    expect(npkFileName('7.15.3', 'arm')).toBe('routeros-7.15.3-arm.npk');
    expect(npkFileName('7.16', 'arm64')).toBe('routeros-7.16-arm64.npk');
  });
  it('puts arch before version on v6', () => {
    expect(npkFileName('6.49.10', 'arm')).toBe('routeros-arm-6.49.10.npk');
    expect(npkFileName('6.48', 'mipsbe')).toBe('routeros-mipsbe-6.48.npk');
  });
});

describe('npkUrl', () => {
  it('builds the download.mikrotik.com URL for the version dir', () => {
    expect(npkUrl('7.15.3', 'arm')).toBe('https://download.mikrotik.com/routeros/7.15.3/routeros-7.15.3-arm.npk');
    expect(npkUrl('6.49.10', 'mipsbe')).toBe('https://download.mikrotik.com/routeros/6.49.10/routeros-mipsbe-6.49.10.npk');
  });
});

describe('extraPackageFileName', () => {
  it('names v7 extra packages <pkg>-<version>-<arch>.npk', () => {
    expect(extraPackageFileName('wifi-qcom', '7.15.3', 'arm')).toBe('wifi-qcom-7.15.3-arm.npk');
    expect(extraPackageFileName('container', '7.16', 'arm64')).toBe('container-7.16-arm64.npk');
  });
});

describe('compareRosVersions', () => {
  it('compares numeric segments', () => {
    expect(compareRosVersions('7.15.3', '7.15.2')).toBe(1);
    expect(compareRosVersions('7.15.2', '7.15.3')).toBe(-1);
    expect(compareRosVersions('7.16', '7.15.9')).toBe(1);
    expect(compareRosVersions('6.49.10', '6.49.9')).toBe(1);
    expect(compareRosVersions('7.15.3', '7.15.3')).toBe(0);
  });
  it('treats a missing patch as .0', () => {
    expect(compareRosVersions('7.16', '7.16.0')).toBe(0);
    expect(compareRosVersions('7.16.1', '7.16')).toBe(1);
  });
  it('ranks a final release above its pre-releases', () => {
    expect(compareRosVersions('7.16', '7.16beta4')).toBe(1);
    expect(compareRosVersions('7.16beta4', '7.16')).toBe(-1);
    expect(compareRosVersions('7.15.3', '7.15.3rc1')).toBe(1);
  });
  it('orders pre-release types alpha < beta < rc', () => {
    expect(compareRosVersions('7.16beta1', '7.16rc1')).toBe(-1);
    expect(compareRosVersions('7.16rc1', '7.16beta9')).toBe(1);
  });
  it('orders pre-release numbers within a type', () => {
    expect(compareRosVersions('7.16beta4', '7.16beta2')).toBe(1);
    expect(compareRosVersions('7.15.3rc1', '7.15.3rc2')).toBe(-1);
  });
});

describe('isDowngrade', () => {
  it('is true when target is lower than installed', () => {
    expect(isDowngrade('7.15.2', '7.15.3')).toBe(true);
    expect(isDowngrade('7.16beta4', '7.16')).toBe(true);
  });
  it('is false for same or higher target', () => {
    expect(isDowngrade('7.15.3', '7.15.3')).toBe(false);
    expect(isDowngrade('7.16', '7.15.3')).toBe(false);
  });
  it('is false when the installed version is unknown', () => {
    expect(isDowngrade('7.15.3', '')).toBe(false);
    expect(isDowngrade('7.15.3', '   ')).toBe(false);
  });
});

describe('extraEnabledPackages', () => {
  it('returns nothing for a clean v7 bundle', () => {
    expect(extraEnabledPackages([{ name: 'routeros', disabled: false }], '7.15.3')).toEqual([]);
  });
  it('flags enabled non-bundle packages on v7', () => {
    const pkgs = [
      { name: 'routeros', disabled: false },
      { name: 'wifi-qcom', disabled: false },
      { name: 'container', disabled: false },
    ];
    expect(extraEnabledPackages(pkgs, '7.15.3')).toEqual(['wifi-qcom', 'container']);
  });
  it('ignores disabled extra packages', () => {
    const pkgs = [
      { name: 'routeros', disabled: false },
      { name: 'container', disabled: true },
    ];
    expect(extraEnabledPackages(pkgs, '7.15.3')).toEqual([]);
  });
  it('treats v6 conservatively — only system is base', () => {
    const pkgs = [
      { name: 'system', disabled: false },
      { name: 'wireless', disabled: false },
      { name: 'dhcp', disabled: false },
    ];
    expect(extraEnabledPackages(pkgs, '6.49.10')).toEqual(['wireless', 'dhcp']);
  });
});
