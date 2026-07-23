# Maintainer: kristofferR <481270+kristofferR@users.noreply.github.com>
#
# Template for the AUR package. The `aur` job in .github/workflows/release.yml
# fills in the version and checksum placeholders and pushes the result (with a
# regenerated .SRCINFO) to the AUR on every release.
pkgname=iptv-checker-gui
pkgver=@PKGVER@
pkgrel=1
pkgdesc="GUI for validating IPTV playlists and inspecting stream health"
arch=('x86_64' 'aarch64')
url="https://github.com/kristofferR/IPTVChecker"
license=('MIT')
depends=('webkit2gtk-4.1' 'gtk3' 'libayatana-appindicator' 'ffmpeg' 'hicolor-icon-theme')
# The unrelated freearhey CLI package also installs /usr/bin/iptv-checker.
conflicts=('iptv-checker')
options=('!strip' '!debug')
source=("LICENSE-${pkgver}::https://raw.githubusercontent.com/kristofferR/IPTVChecker/v${pkgver}/LICENSE")
source_x86_64=("${pkgname}-${pkgver}-x86_64.deb::https://github.com/kristofferR/IPTVChecker/releases/download/v${pkgver}/IPTV.Checker_${pkgver}_lin_x64.deb")
source_aarch64=("${pkgname}-${pkgver}-aarch64.deb::https://github.com/kristofferR/IPTVChecker/releases/download/v${pkgver}/IPTV.Checker_${pkgver}_lin_arm.deb")
sha256sums=('@SHA_LICENSE@')
sha256sums_x86_64=('@SHA_X64@')
sha256sums_aarch64=('@SHA_ARM@')

package() {
    # makepkg already extracted the .deb into srcdir; unpack its payload.
    bsdtar -xf "${srcdir}/data.tar.gz" -C "${pkgdir}"
    # The deb bundles ffmpeg/ffprobe sidecars; on Arch the app falls back to
    # the system ffmpeg on PATH, so drop them to avoid owning ffmpeg's files.
    rm "${pkgdir}/usr/bin/ffmpeg" "${pkgdir}/usr/bin/ffprobe"
    install -Dm644 "${srcdir}/LICENSE-${pkgver}" "${pkgdir}/usr/share/licenses/${pkgname}/LICENSE"
}
