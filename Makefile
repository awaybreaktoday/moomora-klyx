.PHONY: test vet build

# Exclude the Wails mobile-build template stubs under cmd/klyx/build/, which carry
# platform-tagged (`//go:build ios`/`android`) `package main` files that do not
# compile under a desktop `go ./...`. Desktop builds go through `wails3 build`.
PKGS = $(shell go list ./... | grep -v '/cmd/klyx/build/')

test:
	go test $(PKGS)
vet:
	go vet $(PKGS)
build:
	go build $(PKGS)
