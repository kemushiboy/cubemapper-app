// macOS 版に ad-hoc 署名をかける（Apple の証明書なしでも Apple シリコンで起動できるようにする）
const path = require('path');
const { execFileSync } = require('child_process');

exports.default = async function afterPack(context) {
	if (context.electronPlatformName !== 'darwin') return;
	const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
	execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
