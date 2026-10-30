FROM scratch
COPY --chmod=0555 cofisher-relay /cofisher-relay
USER 65532:65532
EXPOSE 23333/tcp
ENTRYPOINT ["/cofisher-relay"]
