# Wine image the Windows host tests run under (`fg-wine`). Build it once with:
#   docker build -t fg-wine -f test/docker/fg-wine.Dockerfile test/docker
# It carries 32-bit and 64-bit Wine so both the x86 (XP, Vista, 7) and x64 hosts run.
FROM debian:bookworm-slim
RUN dpkg --add-architecture i386 \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends wine wine32 wine64 libwine libwine:i386 ca-certificates \
	&& rm -rf /var/lib/apt/lists/*
ENV WINEDEBUG=-all WINEPREFIX=/wine
RUN wineboot -i >/dev/null 2>&1; wineserver -w; true
