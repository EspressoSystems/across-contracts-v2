import {
  expect,
  Contract,
  ethers,
  SignerWithAddress,
  seedWallet,
  toBN,
  randomAddress,
  randomBigNumber,
  BigNumber,
  toWei,
  getContractFactory,
  createRandomBytes32,
} from "../utils/utils";
import {
  spokePoolFixture,
  enableRoutes,
  getExecuteSlowRelayParams,
  SlowFill,
  V3RelayData,
  getV3RelayHash,
  V3SlowFill,
  FillType,
} from "./fixtures/SpokePool.Fixture";
import { getFillRelayParams, getRelayHash } from "./fixtures/SpokePool.Fixture";
import { MerkleTree } from "../utils/MerkleTree";
import { buildSlowRelayTree, buildV3SlowRelayTree } from "./MerkleLib.utils";
import * as consts from "./constants";
import { FillStatus } from "../utils/constants";

let spokePool: Contract, weth: Contract, erc20: Contract, destErc20: Contract;
let depositor: SignerWithAddress, recipient: SignerWithAddress, relayer: SignerWithAddress;
let slowFills: SlowFill[];
let tree: MerkleTree<SlowFill>;

const OTHER_DESTINATION_CHAIN_ID = (consts.destinationChainId + 666).toString();
const ZERO = BigNumber.from(0);

// Random message for ERC20 case.
const erc20Message = randomBigNumber(100).toHexString();

// Random message for WETH case.
const wethMessage = randomBigNumber(100).toHexString();

// Relay fees for slow relay are only the realizedLpFee; the depositor should be re-funded the relayer fee
// for any amount sent by a slow relay.
const fullRelayAmountPostFees = consts.amountToRelay
  .mul(toBN(consts.oneHundredPct).sub(consts.realizedLpFeePct))
  .div(toBN(consts.oneHundredPct));

describe("SpokePool Slow Relay Logic", async function () {
  beforeEach(async function () {
    [depositor, recipient, relayer] = await ethers.getSigners();
    ({ weth, erc20, spokePool, destErc20 } = await spokePoolFixture());

    // mint some fresh tokens and deposit ETH for weth for depositor and relayer.
    await seedWallet(depositor, [erc20], weth, consts.amountToSeedWallets);
    await seedWallet(depositor, [destErc20], weth, consts.amountToSeedWallets);
    await seedWallet(relayer, [erc20], weth, consts.amountToSeedWallets);
    await seedWallet(relayer, [destErc20], weth, consts.amountToSeedWallets);

    // Send tokens to the spoke pool for repayment.
    await destErc20.connect(depositor).transfer(spokePool.address, fullRelayAmountPostFees.mul(10));
    await weth.connect(depositor).transfer(spokePool.address, fullRelayAmountPostFees.div(2));

    // Approve spoke pool to take relayer's tokens.
    await destErc20.connect(relayer).approve(spokePool.address, fullRelayAmountPostFees);
    await weth.connect(relayer).approve(spokePool.address, fullRelayAmountPostFees);

    // Whitelist origin token => destination chain ID routes:
    await enableRoutes(spokePool, [{ originToken: erc20.address }, { originToken: weth.address }]);

    slowFills = [];
    for (let i = 0; i < 99; i++) {
      // Relay for different destination chain
      slowFills.push({
        relayData: {
          depositor: randomAddress(),
          recipient: randomAddress(),
          destinationToken: randomAddress(),
          amount: randomBigNumber(),
          originChainId: randomBigNumber(2).toString(),
          destinationChainId: OTHER_DESTINATION_CHAIN_ID,
          realizedLpFeePct: randomBigNumber(8, true),
          relayerFeePct: randomBigNumber(8, true),
          depositId: randomBigNumber(2).toString(),
          message: randomBigNumber(100).toHexString(),
        },
        payoutAdjustmentPct: toBN(0),
      });
    }

    // ERC20
    slowFills.push({
      relayData: {
        depositor: depositor.address,
        recipient: recipient.address,
        destinationToken: destErc20.address,
        amount: consts.amountToRelay,
        originChainId: consts.originChainId.toString(),
        destinationChainId: consts.destinationChainId.toString(),
        realizedLpFeePct: consts.realizedLpFeePct,
        relayerFeePct: consts.depositRelayerFeePct,
        depositId: consts.firstDepositId.toString(),
        message: erc20Message,
      },
      payoutAdjustmentPct: ethers.utils.parseEther("9"), // 10x payout.
    });

    // WETH
    slowFills.push({
      relayData: {
        depositor: depositor.address,
        recipient: recipient.address,
        destinationToken: weth.address,
        amount: consts.amountToRelay,
        originChainId: consts.originChainId.toString(),
        destinationChainId: consts.destinationChainId.toString(),
        realizedLpFeePct: consts.realizedLpFeePct,
        relayerFeePct: consts.depositRelayerFeePct,
        depositId: consts.firstDepositId.toString(),
        message: wethMessage,
      },
      payoutAdjustmentPct: ethers.utils.parseEther("-0.5"), // 50% payout.
    });

    // Broken payout adjustment, too small.
    slowFills.push({
      relayData: {
        depositor: depositor.address,
        recipient: recipient.address,
        destinationToken: weth.address,
        amount: consts.amountToRelay,
        originChainId: consts.originChainId.toString(),
        destinationChainId: consts.destinationChainId.toString(),
        realizedLpFeePct: consts.realizedLpFeePct,
        relayerFeePct: consts.depositRelayerFeePct,
        depositId: consts.firstDepositId.toString(),
        message: wethMessage,
      },
      payoutAdjustmentPct: ethers.utils.parseEther("-1.01"), // Over -100% payout.
    });

    // Broken payout adjustment, too large.
    slowFills.push({
      relayData: {
        depositor: depositor.address,
        recipient: recipient.address,
        destinationToken: destErc20.address,
        amount: consts.amountToRelay,
        originChainId: consts.originChainId.toString(),
        destinationChainId: consts.destinationChainId.toString(),
        realizedLpFeePct: consts.realizedLpFeePct,
        relayerFeePct: consts.depositRelayerFeePct,
        depositId: consts.firstDepositId.toString(),
        message: erc20Message,
      },
      payoutAdjustmentPct: ethers.utils.parseEther("101"), // 10000% payout is the limit.
    });

    tree = await buildSlowRelayTree(slowFills);

    await spokePool.connect(depositor).relayRootBundle(consts.mockTreeRoot, tree.getHexRoot());
  });
  it("Simple SlowRelay ERC20 balances", async function () {
    await expect(() =>
      spokePool
        .connect(relayer)
        .executeSlowRelayLeaf(
          ...getExecuteSlowRelayParams(
            depositor.address,
            recipient.address,
            destErc20.address,
            consts.amountToRelay,
            consts.originChainId,
            consts.realizedLpFeePct,
            consts.depositRelayerFeePct,
            consts.firstDepositId,
            0,
            erc20Message,
            ethers.utils.parseEther("9"),
            tree.getHexProof(slowFills.find((slowFill) => slowFill.relayData.destinationToken === destErc20.address)!)
          )
        )
    ).to.changeTokenBalances(
      destErc20,
      [spokePool, recipient],
      [fullRelayAmountPostFees.mul(10).mul(-1), fullRelayAmountPostFees.mul(10)]
    );
  });
  it("Recipient should be able to execute their own slow relay", async function () {
    await expect(() =>
      spokePool
        .connect(recipient)
        .executeSlowRelayLeaf(
          ...getExecuteSlowRelayParams(
            depositor.address,
            recipient.address,
            destErc20.address,
            consts.amountToRelay,
            consts.originChainId,
            consts.realizedLpFeePct,
            consts.depositRelayerFeePct,
            consts.firstDepositId,
            0,
            erc20Message,
            ethers.utils.parseEther("9"),
            tree.getHexProof(slowFills.find((slowFill) => slowFill.relayData.destinationToken === destErc20.address)!)
          )
        )
    ).to.changeTokenBalances(
      destErc20,
      [spokePool, recipient],
      [fullRelayAmountPostFees.mul(10).mul(-1), fullRelayAmountPostFees.mul(10)]
    );
  });

  it("Simple SlowRelay ERC20 FilledRelay event", async function () {
    slowFills.find((slowFill) => slowFill.relayData.destinationToken === destErc20.address)!;

    await expect(
      spokePool
        .connect(relayer)
        .executeSlowRelayLeaf(
          ...getExecuteSlowRelayParams(
            depositor.address,
            recipient.address,
            destErc20.address,
            consts.amountToRelay,
            consts.originChainId,
            consts.realizedLpFeePct,
            consts.depositRelayerFeePct,
            consts.firstDepositId,
            0,
            erc20Message,
            ethers.utils.parseEther("9"),
            tree.getHexProof(slowFills.find((slowFill) => slowFill.relayData.destinationToken === destErc20.address)!)
          )
        )
    )
      .to.emit(spokePool, "FilledRelay")
      .withArgs(
        consts.amountToRelay,
        consts.amountToRelay,
        consts.amountToRelay,
        0, // Repayment chain ID should always be 0 for slow relay fills.
        consts.originChainId,
        consts.destinationChainId,
        consts.depositRelayerFeePct,
        consts.realizedLpFeePct,
        consts.firstDepositId,
        destErc20.address,
        relayer.address,
        depositor.address,
        recipient.address,
        erc20Message,
        [
          recipient.address,
          erc20Message,
          0, // Should not have an applied relayerFeePct for slow relay fills.
          true,
          "9000000000000000000",
        ]
      );
  });

  it("Simple SlowRelay WETH balance", async function () {
    await expect(() =>
      spokePool
        .connect(relayer)
        .executeSlowRelayLeaf(
          ...getExecuteSlowRelayParams(
            depositor.address,
            recipient.address,
            weth.address,
            consts.amountToRelay,
            consts.originChainId,
            consts.realizedLpFeePct,
            consts.depositRelayerFeePct,
            consts.firstDepositId,
            0,
            wethMessage,
            ethers.utils.parseEther("-0.5"),
            tree.getHexProof(slowFills.find((slowFill) => slowFill.relayData.destinationToken === weth.address)!)
          )
        )
    ).to.changeTokenBalances(weth, [spokePool], [fullRelayAmountPostFees.div(2).mul(-1)]);
  });

  it("Simple SlowRelay ETH balance", async function () {
    await expect(() =>
      spokePool
        .connect(relayer)
        .executeSlowRelayLeaf(
          ...getExecuteSlowRelayParams(
            depositor.address,
            recipient.address,
            weth.address,
            consts.amountToRelay,
            consts.originChainId,
            consts.realizedLpFeePct,
            consts.depositRelayerFeePct,
            consts.firstDepositId,
            0,
            wethMessage,
            ethers.utils.parseEther("-0.5"),
            tree.getHexProof(slowFills.find((slowFill) => slowFill.relayData.destinationToken === weth.address)!)
          )
        )
    ).to.changeEtherBalance(recipient, fullRelayAmountPostFees.div(2));
  });

  it("Partial SlowRelay ERC20 balances", async function () {
    // Work out a partial amount to fill. Send 1/4 of full amount.
    const partialAmount = consts.amountToRelay.mul(toWei("0.25")).div(consts.oneHundredPct);
    // This is the amount that we will actually send to the recipient post-fees.
    const partialAmountPostFees = partialAmount
      .mul(consts.oneHundredPct.sub(consts.depositRelayerFeePct).sub(consts.realizedLpFeePct))
      .div(consts.oneHundredPct);
    // This is the on-chain remaining amount of the relay.
    const remainingFillAmount = consts.amountToRelay.sub(partialAmount);
    // This is the amount sent to recipient after the slow fill removes the realized LP fee. The relayer fee is credited back to user.
    const slowFillAmountPostFees = remainingFillAmount
      .mul(consts.oneHundredPct.sub(consts.realizedLpFeePct))
      .div(consts.oneHundredPct);
    await spokePool.connect(relayer).fillRelay(
      ...getFillRelayParams(
        getRelayHash(
          depositor.address,
          recipient.address,
          consts.firstDepositId,
          consts.originChainId,
          consts.destinationChainId,
          destErc20.address,
          consts.amountToRelay,
          undefined,
          undefined,
          erc20Message
        ).relayData,
        partialAmountPostFees, // Set post fee amount as max amount to send so that relay filled amount is
        // decremented by exactly the `partialAmount`.
        consts.destinationChainId // Partial fills must set repayment chain to destination.
      )
    );
    await expect(() =>
      spokePool
        .connect(relayer)
        .executeSlowRelayLeaf(
          ...getExecuteSlowRelayParams(
            depositor.address,
            recipient.address,
            destErc20.address,
            consts.amountToRelay,
            consts.originChainId,
            consts.realizedLpFeePct,
            consts.depositRelayerFeePct,
            consts.firstDepositId,
            0,
            erc20Message,
            ethers.utils.parseEther("9"),
            tree.getHexProof(slowFills.find((slowFill) => slowFill.relayData.destinationToken === destErc20.address)!)
          )
        )
    ).to.changeTokenBalances(
      destErc20,
      [spokePool, recipient],
      [slowFillAmountPostFees.mul(10).mul(-1), slowFillAmountPostFees.mul(10)]
    );
  });

  it("Partial SlowRelay WETH balance", async function () {
    const partialAmount = consts.amountToRelay.mul(toWei("0.25")).div(consts.oneHundredPct);
    const partialAmountPostFees = partialAmount
      .mul(consts.oneHundredPct.sub(consts.depositRelayerFeePct).sub(consts.realizedLpFeePct))
      .div(consts.oneHundredPct);
    const remainingFillAmount = consts.amountToRelay.sub(partialAmount);
    const slowFillAmountPostFees = remainingFillAmount
      .mul(consts.oneHundredPct.sub(consts.realizedLpFeePct))
      .div(consts.oneHundredPct);

    await spokePool
      .connect(relayer)
      .fillRelay(
        ...getFillRelayParams(
          getRelayHash(
            depositor.address,
            recipient.address,
            consts.firstDepositId,
            consts.originChainId,
            consts.destinationChainId,
            weth.address,
            consts.amountToRelay,
            undefined,
            undefined,
            wethMessage
          ).relayData,
          partialAmountPostFees,
          consts.destinationChainId
        )
      );

    await expect(() =>
      spokePool
        .connect(relayer)
        .executeSlowRelayLeaf(
          ...getExecuteSlowRelayParams(
            depositor.address,
            recipient.address,
            weth.address,
            consts.amountToRelay,
            consts.originChainId,
            consts.realizedLpFeePct,
            consts.depositRelayerFeePct,
            consts.firstDepositId,
            0,
            wethMessage,
            ethers.utils.parseEther("-0.5"),
            tree.getHexProof(slowFills.find((slowFill) => slowFill.relayData.destinationToken === weth.address)!)
          )
        )
    ).to.changeTokenBalances(weth, [spokePool], [slowFillAmountPostFees.div(2).mul(-1)]);
  });

  it("Partial SlowRelay ETH balance", async function () {
    const partialAmount = consts.amountToRelay.mul(toWei("0.25")).div(consts.oneHundredPct);
    const partialAmountPostFees = partialAmount
      .mul(consts.oneHundredPct.sub(consts.depositRelayerFeePct).sub(consts.realizedLpFeePct))
      .div(consts.oneHundredPct);
    const remainingFillAmount = consts.amountToRelay.sub(partialAmount);
    const slowFillAmountPostFees = remainingFillAmount
      .mul(consts.oneHundredPct.sub(consts.realizedLpFeePct))
      .div(consts.oneHundredPct);

    await spokePool
      .connect(relayer)
      .fillRelay(
        ...getFillRelayParams(
          getRelayHash(
            depositor.address,
            recipient.address,
            consts.firstDepositId,
            consts.originChainId,
            consts.destinationChainId,
            weth.address,
            consts.amountToRelay,
            undefined,
            undefined,
            wethMessage
          ).relayData,
          partialAmountPostFees,
          consts.destinationChainId
        )
      );

    await expect(() =>
      spokePool
        .connect(relayer)
        .executeSlowRelayLeaf(
          ...getExecuteSlowRelayParams(
            depositor.address,
            recipient.address,
            weth.address,
            consts.amountToRelay,
            consts.originChainId,
            consts.realizedLpFeePct,
            consts.depositRelayerFeePct,
            consts.firstDepositId,
            0,
            wethMessage,
            ethers.utils.parseEther("-0.5"),
            tree.getHexProof(slowFills.find((slowFill) => slowFill.relayData.destinationToken === weth.address)!)
          )
        )
    ).to.changeEtherBalance(recipient, slowFillAmountPostFees.div(2));
  });

  it("Payout adjustment too large", async function () {
    await expect(
      spokePool
        .connect(relayer)
        .executeSlowRelayLeaf(
          ...getExecuteSlowRelayParams(
            depositor.address,
            recipient.address,
            destErc20.address,
            consts.amountToRelay,
            consts.originChainId,
            consts.realizedLpFeePct,
            consts.depositRelayerFeePct,
            consts.firstDepositId,
            0,
            erc20Message,
            ethers.utils.parseEther("101"),
            tree.getHexProof(
              slowFills.find(
                (slowFill) =>
                  slowFill.relayData.destinationToken === destErc20.address &&
                  slowFill.payoutAdjustmentPct.eq(ethers.utils.parseEther("101"))
              )!
            )
          )
        )
    ).to.revertedWith("payoutAdjustmentPct too large");
  });

  it("Payout adjustment too small", async function () {
    await expect(
      spokePool
        .connect(relayer)
        .executeSlowRelayLeaf(
          ...getExecuteSlowRelayParams(
            depositor.address,
            recipient.address,
            weth.address,
            consts.amountToRelay,
            consts.originChainId,
            consts.realizedLpFeePct,
            consts.depositRelayerFeePct,
            consts.firstDepositId,
            0,
            wethMessage,
            ethers.utils.parseEther("-1.01"),
            tree.getHexProof(
              slowFills.find(
                (slowFill) =>
                  slowFill.relayData.destinationToken === weth.address &&
                  slowFill.payoutAdjustmentPct.eq(ethers.utils.parseEther("-1.01"))
              )!
            )
          )
        )
    ).to.revertedWith("payoutAdjustmentPct too small");
  });

  it("Bad proof: Relay data is correct except that destination chain ID doesn't match spoke pool's", async function () {
    const slowFill = slowFills.find((fill) => fill.relayData.destinationChainId === OTHER_DESTINATION_CHAIN_ID)!;

    // This should revert because the relay struct that we found via .find() is the one inserted in the merkle root
    // published to the spoke pool, but its destination chain ID is OTHER_DESTINATION_CHAIN_ID, which is different
    // than the spoke pool's destination chain ID.
    await expect(
      spokePool
        .connect(relayer)
        .executeSlowRelayLeaf(
          ...getExecuteSlowRelayParams(
            slowFill.relayData.depositor,
            slowFill.relayData.recipient,
            slowFill.relayData.destinationToken,
            toBN(slowFill.relayData.amount),
            Number(slowFill.relayData.originChainId),
            toBN(slowFill.relayData.realizedLpFeePct),
            toBN(slowFill.relayData.relayerFeePct),
            Number(slowFill.relayData.depositId),
            0,
            slowFill.relayData.message,
            ZERO,
            tree.getHexProof(slowFill!)
          )
        )
    ).to.be.revertedWith("Invalid slow relay proof");
  });

  it("Bad proof: Relay data besides destination chain ID is not included in merkle root", async function () {
    await expect(
      spokePool.connect(relayer).executeSlowRelayLeaf(
        ...getExecuteSlowRelayParams(
          depositor.address,
          recipient.address,
          weth.address,
          consts.amountToRelay.sub(1), // Slightly modify the relay data from the expected set.
          consts.originChainId,
          consts.realizedLpFeePct,
          consts.depositRelayerFeePct,
          consts.firstDepositId,
          0,
          "0x1234",
          ZERO,
          tree.getHexProof(slowFills.find((slowFill) => slowFill.relayData.destinationToken === weth.address)!)
        )
      )
    ).to.be.reverted;
  });

  describe("requestV3SlowFill", function () {
    let relayData: V3RelayData;
    beforeEach(async function () {
      const fillDeadline = (await spokePool.getCurrentTime()).toNumber() + 1000;
      relayData = {
        depositor: depositor.address,
        recipient: recipient.address,
        exclusiveRelayer: relayer.address,
        inputToken: erc20.address,
        outputToken: destErc20.address,
        inputAmount: consts.amountToDeposit,
        outputAmount: fullRelayAmountPostFees,
        originChainId: consts.originChainId,
        depositId: consts.firstDepositId,
        fillDeadline: fillDeadline,
        exclusivityDeadline: fillDeadline - 500,
        message: "0x",
      };
      // By default, set current time to after exclusivity deadline
      await spokePool.setCurrentTime(relayData.exclusivityDeadline + 1);
    });
    it("fill deadline is expired", async function () {
      relayData.fillDeadline = (await spokePool.getCurrentTime()).sub(1);
      await expect(spokePool.connect(relayer).requestV3SlowFill(relayData)).to.be.revertedWith("ExpiredFillDeadline");
    });
    it("during exclusivity deadline", async function () {
      await spokePool.setCurrentTime(relayData.exclusivityDeadline);
      await expect(spokePool.connect(relayer).requestV3SlowFill(relayData)).to.be.revertedWith(
        "NoSlowFillsInExclusivityWindow"
      );
    });
    it("can request before fast fill", async function () {
      const relayHash = getV3RelayHash(relayData, consts.destinationChainId);

      // FillStatus must be Unfilled:
      expect(await spokePool.fillStatuses(relayHash)).to.equal(FillStatus.Unfilled);
      expect(await spokePool.connect(relayer).requestV3SlowFill(relayData)).to.emit(spokePool, "RequestedV3SlowFill");

      // FillStatus gets reset to RequestedSlowFill:
      expect(await spokePool.fillStatuses(relayHash)).to.equal(FillStatus.RequestedSlowFill);

      // Can't request slow fill again:
      await expect(spokePool.connect(relayer).requestV3SlowFill(relayData)).to.be.revertedWith(
        "InvalidSlowFillRequest"
      );

      // Can fast fill after:
      await spokePool.connect(relayer).fillV3Relay(relayData, consts.repaymentChainId);
    });
    it("cannot request if FillStatus is Filled", async function () {
      const relayHash = getV3RelayHash(relayData, consts.destinationChainId);
      await spokePool.setFillStatus(relayHash, FillStatus.Filled);
      expect(await spokePool.fillStatuses(relayHash)).to.equal(FillStatus.Filled);
      await expect(spokePool.connect(relayer).requestV3SlowFill(relayData)).to.be.revertedWith(
        "InvalidSlowFillRequest"
      );
    });
    it("fills are not paused", async function () {
      await spokePool.pauseFills(true);
      await expect(spokePool.connect(relayer).requestV3SlowFill(relayData)).to.be.revertedWith("Paused fills");
    });
    it("reentrancy protected", async function () {
      // In this test we create a reentrancy attempt by sending a fill with a recipient contract that calls back into
      // the spoke pool via the tested function.
      const functionCalldata = spokePool.interface.encodeFunctionData("requestV3SlowFill", [relayData]);
      await expect(spokePool.connect(depositor).callback(functionCalldata)).to.be.revertedWith(
        "ReentrancyGuard: reentrant call"
      );
    });
  });
  describe("executeV3SlowRelayLeaf", function () {
    let relayData: V3RelayData, slowRelayLeaf: V3SlowFill;
    beforeEach(async function () {
      const fillDeadline = (await spokePool.getCurrentTime()).toNumber() + 1000;
      relayData = {
        depositor: depositor.address,
        recipient: recipient.address,
        exclusiveRelayer: relayer.address,
        inputToken: erc20.address,
        outputToken: destErc20.address,
        inputAmount: consts.amountToDeposit,
        outputAmount: fullRelayAmountPostFees,
        originChainId: consts.originChainId,
        depositId: consts.firstDepositId,
        fillDeadline: fillDeadline,
        exclusivityDeadline: fillDeadline - 500,
        message: "0x",
      };
      slowRelayLeaf = {
        relayData,
        chainId: consts.destinationChainId,
        // Make updated output amount different to test whether it is used instead of
        // outputAmount when calling _verifyV3SlowFill.
        updatedOutputAmount: relayData.outputAmount.add(1),
      };
    });
    it("Happy case: recipient can send ERC20 with correct proof out of contract balance", async function () {
      const tree = await buildV3SlowRelayTree([slowRelayLeaf]);
      await spokePool.connect(depositor).relayRootBundle(consts.mockTreeRoot, tree.getHexRoot());
      await expect(() =>
        spokePool.connect(recipient).executeV3SlowRelayLeaf(
          slowRelayLeaf,
          1, // rootBundleId
          tree.getHexProof(slowRelayLeaf)
        )
      ).to.changeTokenBalances(
        destErc20,
        [spokePool, recipient],
        [slowRelayLeaf.updatedOutputAmount.mul(-1), slowRelayLeaf.updatedOutputAmount]
      );
    });
    it("cannot double execute leaf", async function () {
      const tree = await buildV3SlowRelayTree([slowRelayLeaf]);
      await spokePool.connect(depositor).relayRootBundle(consts.mockTreeRoot, tree.getHexRoot());
      await spokePool.connect(relayer).executeV3SlowRelayLeaf(
        slowRelayLeaf,
        1, // rootBundleId
        tree.getHexProof(slowRelayLeaf)
      );
      await expect(
        spokePool.connect(relayer).executeV3SlowRelayLeaf(
          slowRelayLeaf,
          1, // rootBundleId
          tree.getHexProof(slowRelayLeaf)
        )
      ).to.be.revertedWith("RelayFilled");

      // Cannot fast fill after slow fill
      await expect(
        spokePool.connect(relayer).fillV3Relay(slowRelayLeaf.relayData, consts.repaymentChainId)
      ).to.be.revertedWith("RelayFilled");
    });
    it("cannot be used to double send a fill", async function () {
      const tree = await buildV3SlowRelayTree([slowRelayLeaf]);
      await spokePool.connect(depositor).relayRootBundle(consts.mockTreeRoot, tree.getHexRoot());

      // Fill before executing slow fill
      await spokePool.connect(relayer).fillV3Relay(slowRelayLeaf.relayData, consts.repaymentChainId);
      await expect(
        spokePool.connect(relayer).executeV3SlowRelayLeaf(
          slowRelayLeaf,
          1, // rootBundleId
          tree.getHexProof(slowRelayLeaf)
        )
      ).to.be.revertedWith("RelayFilled");
    });
    it("cannot re-enter", async function () {
      const tree = await buildV3SlowRelayTree([slowRelayLeaf]);
      const functionCalldata = spokePool.interface.encodeFunctionData("executeV3SlowRelayLeaf", [
        slowRelayLeaf,
        1, // rootBundleId
        tree.getHexProof(slowRelayLeaf),
      ]);
      await expect(spokePool.connect(depositor).callback(functionCalldata)).to.be.revertedWith(
        "ReentrancyGuard: reentrant call"
      );
    });
    it("can execute even if fills are paused", async function () {
      await spokePool.pauseFills(true);
      const tree = await buildV3SlowRelayTree([slowRelayLeaf]);
      await spokePool.connect(depositor).relayRootBundle(consts.mockTreeRoot, tree.getHexRoot());
      await expect(
        spokePool.connect(relayer).executeV3SlowRelayLeaf(
          slowRelayLeaf,
          1, // rootBundleId
          tree.getHexProof(slowRelayLeaf)
        )
      ).to.not.be.reverted;
    });
    it("executes _preExecuteLeafHook", async function () {
      const tree = await buildV3SlowRelayTree([slowRelayLeaf]);
      await spokePool.connect(depositor).relayRootBundle(consts.mockTreeRoot, tree.getHexRoot());
      await expect(
        spokePool.connect(relayer).executeV3SlowRelayLeaf(
          slowRelayLeaf,
          1, // rootBundleId
          tree.getHexProof(slowRelayLeaf)
        )
      )
        .to.emit(spokePool, "PreLeafExecuteHook")
        .withArgs(slowRelayLeaf.relayData.outputToken);
    });
    it("cannot execute leaves with chain IDs not matching spoke pool's chain ID", async function () {
      // In this test, the merkle proof is valid for the tree relayed to the spoke pool, but the merkle leaf
      // destination chain ID does not match the spoke pool's chainId() and therefore cannot be executed.
      const slowRelayLeafWithWrongDestinationChain: V3SlowFill = {
        ...slowRelayLeaf,
        chainId: slowRelayLeaf.chainId + 1,
      };
      const treeWithWrongDestinationChain = await buildV3SlowRelayTree([slowRelayLeafWithWrongDestinationChain]);
      await spokePool
        .connect(depositor)
        .relayRootBundle(consts.mockTreeRoot, treeWithWrongDestinationChain.getHexRoot());
      await expect(
        spokePool.connect(relayer).executeV3SlowRelayLeaf(
          slowRelayLeafWithWrongDestinationChain,
          1, // rootBundleId
          treeWithWrongDestinationChain.getHexProof(slowRelayLeafWithWrongDestinationChain)
        )
      ).to.be.revertedWith("InvalidMerkleProof");
    });
    it("_verifyV3SlowFill", async function () {
      const leafWithDifferentUpdatedOutputAmount = {
        ...slowRelayLeaf,
        updatedOutputAmount: slowRelayLeaf.updatedOutputAmount.add(1),
      };

      const tree = await buildV3SlowRelayTree([slowRelayLeaf, leafWithDifferentUpdatedOutputAmount]);
      await spokePool.connect(depositor).relayRootBundle(consts.mockTreeRoot, tree.getHexRoot());

      // Incorrect root bundle ID
      await expect(
        spokePool.connect(relayer).executeV3SlowRelayLeaf(
          slowRelayLeaf,
          0, // rootBundleId should be 1
          tree.getHexProof(slowRelayLeaf)
        )
      ).to.revertedWith("InvalidMerkleProof");

      // Invalid proof
      await expect(
        spokePool.connect(relayer).executeV3SlowRelayLeaf(
          slowRelayLeaf,
          1,
          tree.getHexProof(leafWithDifferentUpdatedOutputAmount) // Invalid proof
        )
      ).to.revertedWith("InvalidMerkleProof");

      // Incorrect relay execution params, not matching leaf used to construct proof
      await expect(
        spokePool
          .connect(relayer)
          .executeV3SlowRelayLeaf(leafWithDifferentUpdatedOutputAmount, 1, tree.getHexProof(slowRelayLeaf))
      ).to.revertedWith("InvalidMerkleProof");
    });
    it("calls _fillRelay with expected params", async function () {
      const tree = await buildV3SlowRelayTree([slowRelayLeaf]);
      await spokePool.connect(depositor).relayRootBundle(consts.mockTreeRoot, tree.getHexRoot());

      await expect(
        spokePool.connect(relayer).executeV3SlowRelayLeaf(
          slowRelayLeaf,
          1, // rootBundleId
          tree.getHexProof(slowRelayLeaf)
        )
      )
        .to.emit(spokePool, "FilledV3Relay")
        .withArgs(
          relayData.inputToken,
          relayData.outputToken,
          relayData.inputAmount,
          relayData.outputAmount,
          // Sets repaymentChainId to 0:
          0,
          relayData.originChainId,
          relayData.depositId,
          relayData.fillDeadline,
          relayData.exclusivityDeadline,
          relayData.exclusiveRelayer,
          // Sets relayer address to 0x0
          consts.zeroAddress,
          relayData.depositor,
          relayData.recipient,
          relayData.message,
          [
            // Uses relayData.recipient
            relayData.recipient,
            // Uses relayData.message
            relayData.message,
            // Uses slow fill leaf's updatedOutputAmount
            slowRelayLeaf.updatedOutputAmount,
            // Should be SlowFill
            FillType.SlowFill,
          ]
        );

      // Sanity check that executed slow fill leaf's updatedOutputAmount is different than the relayData.outputAmount
      // since we test for it above.
      expect(slowRelayLeaf.relayData.outputAmount).to.not.equal(slowRelayLeaf.updatedOutputAmount);
    });
  });
});
