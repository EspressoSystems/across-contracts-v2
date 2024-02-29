{
  description = "A Nix-flake-based Node.js development environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-23.05";
  inputs.flake-utils.url = "github:numtide/flake-utils";
  # inputs.solc-bin.url = "github:EspressoSystems/nix-solc-bin";

  outputs =
    { self
    , nixpkgs
    , flake-utils
    , # solc-bin,
    }:
    flake-utils.lib.eachDefaultSystem (system:
    let
      overlays = [
        (final: prev: rec {
          nodejs = prev.nodejs_16;
          pnpm = prev.nodePackages.pnpm;
          yarn = (prev.yarn.override {
            inherit nodejs;
          });
        })
        # solc-bin.overlays.default
      ];
      pkgs = import nixpkgs {
        inherit system overlays;
        config.permittedInsecurePackages = [
          "nodejs-16.20.2"
        ];
      };
    in
    {
      devShells = {
        default = pkgs.mkShell {
          packages = with pkgs; [
            nodePackages.typescript
            nodePackages.typescript-language-server
            nodePackages.node-gyp-build
            nodejs
            yarn
            python3
          ];
          shellHook = ''
            # For node tools like hardhat
            export PATH="$PWD/node_modules/.bin:$PATH"
          '';
        };
      };
    }
    );
}
