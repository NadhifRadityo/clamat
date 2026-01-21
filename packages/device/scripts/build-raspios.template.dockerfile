FROM <%- toolchainImage %>

<% for(const [key, value] of Object.entries(toolchainImageLabels).filter(([k, v]) => k.startsWith("ETAG_") && v != "")) { -%>
LABEL ETAG_<%- key.slice("ETAG_".length) %>="" %>
<% } -%>
<% for(const [key, value] of Object.entries(toolchainImageLabels).filter(([k, v]) => k.startsWith("ETAG_") && v != "")) { -%>
LABEL ETAG_TOOLCHAIN_<%- key.slice("ETAG_".length) %>=<%- value %>
<% } -%>
LABEL ETAG_TEMPLATE=<%- dockerfileTemplateEtag %>
LABEL ETAG_JSON=<%- prunedMonorepoEtag %>

WORKDIR /root/app

RUN npm i -g corepack
COPY app/json/package.json .
RUN corepack prepare
COPY app/json/ .
RUN pnpm i

VOLUME /root/app
CMD ["pnpm", "turbo", "run", "build"]
