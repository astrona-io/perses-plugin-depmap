# Plugin-only image, mounted into the Perses pod as a Kubernetes image volume.
# It holds no binaries: just the archive that `percli plugin build` produces,
# at the image root, which is what the volume mount exposes.
#
#   percli plugin build            # writes DepMap-<version>.tar.gz
#   podman build -t <registry>/perses-plugin-depmap:<version> .
#
# See "Install into Perses" in README.md.
FROM scratch
ARG VERSION=0.2.0
COPY DepMap-${VERSION}.tar.gz /
LABEL org.opencontainers.image.title="perses-plugin-depmap" \
      org.opencontainers.image.description="Perses DependencyMapChart panel plugin archive (for an image volume)" \
      org.opencontainers.image.licenses="Apache-2.0"
