import { expect } from "chai";
import { BigNumber, Wallet, constants, ContractTransaction } from "ethers";
import { deployments, ethers, waffle } from "hardhat";
const { parseUnits, parseEther } = ethers.utils;
const parseBtc = (value: string) => parseUnits(value, 8);
import { prepareSignature, advanceTimeAndBlock, currentTime, getReceiptId, Status } from "./helper";
import { DeCusSystem, SATS, ERC20, KeeperRegistry, DeCus, SwapRewarder } from "../build/typechain";

const SATOSHI_SATS_MULTIPLIER = BigNumber.from(10).pow(10);
const KEEPER_SATOSHI = parseBtc("0.5"); // 50000000
const GROUP_SATOSHI = parseBtc("0.6");
const BTC_ADDRESS = [
    "38aNsdfsdfsdfsdfsdfdsfsdf0",
    "38aNsdfsdfsdfsdfsdfdsfsdf1",
    "38aNsdfsdfsdfsdfsdfdsfsdf2",
];

const setupFixture = deployments.createFixture(async ({ ethers, deployments }) => {
    await deployments.fixture();

    const [deployer, ...users] = waffle.provider.getWallets(); // position 0 is used as deployer
    const wbtc = (await ethers.getContract("WBTC")) as ERC20;
    const registry = (await ethers.getContract("KeeperRegistry")) as KeeperRegistry;
    const system = (await ethers.getContract("DeCusSystem")) as DeCusSystem;
    const sats = (await ethers.getContract("SATS")) as SATS;
    const dcs = (await ethers.getContract("DeCus")) as DeCus;
    const rewarder = (await ethers.getContract("SwapRewarder")) as SwapRewarder;

    for (const user of users) {
        await wbtc.mint(user.address, parseBtc("100"));
        await wbtc.connect(user).approve(registry.address, parseBtc("100"));
        await registry.connect(user).addKeeper(wbtc.address, KEEPER_SATOSHI);
    }

    return { deployer, users, system, sats, dcs, rewarder };
});

describe("DeCusSystem", function () {
    let deployer: Wallet;
    let users: Wallet[];
    let system: DeCusSystem;
    let sats: SATS;
    let dcs: DeCus;
    let rewarder: SwapRewarder;
    let group1Keepers: Wallet[];
    let group2Keepers: Wallet[];
    let group1Verifiers: Wallet[];
    let group2Verifiers: Wallet[];

    beforeEach(async function () {
        ({ deployer, users, system, sats, dcs, rewarder } = await setupFixture());
        group1Keepers = [users[0], users[1], users[2], users[3]];
        group2Keepers = [users[0], users[1], users[4], users[5]];

        group1Verifiers = group1Keepers.slice(1);
        group2Verifiers = group2Keepers.slice(1);
    });

    describe("constant", function () {
        it("constant", async function () {
            expect(await sats.BTC_MULTIPLIER()).to.be.equal(1e8);
        });
    });

    describe("getReceiptId()", function () {
        it("should get receipt ID", async function () {
            const btcAddress = BTC_ADDRESS[0];
            const nonce = 1;
            expect(await system.getReceiptId(btcAddress, nonce)).to.be.equal(
                getReceiptId(btcAddress, nonce)
            );
        });
    });

    describe("addGroup()", function () {
        const GROUP_ROLE = ethers.utils.id("GROUP_ROLE");
        let groupAdmin: Wallet;

        beforeEach(async function () {
            groupAdmin = users[9];
            await system.connect(deployer).grantRole(GROUP_ROLE, groupAdmin.address);
            await system.connect(deployer).revokeRole(GROUP_ROLE, deployer.address);
        });

        it("update minKeeperWei", async function () {
            expect(await system.minKeeperWei()).to.be.gt(parseEther("0.000001"));
            const minKeeperWei = parseEther("1");
            expect(await system.minKeeperWei()).to.be.lt(minKeeperWei);

            await expect(system.connect(deployer).updateMinKeeperWei(minKeeperWei))
                .to.emit(system, "MinKeeperWeiUpdated")
                .withArgs(minKeeperWei);

            const keepers = group1Keepers.map((x) => x.address);
            await expect(
                system.connect(groupAdmin).addGroup(BTC_ADDRESS[0], 3, GROUP_SATOSHI, keepers)
            ).to.revertedWith("keeper has not enough collateral");
        });

        it("should add group", async function () {
            const keepers = group1Keepers.map((x) => x.address);
            await expect(
                system.connect(groupAdmin).addGroup(BTC_ADDRESS[0], 3, GROUP_SATOSHI, keepers)
            )
                .to.emit(system, "GroupAdded")
                .withArgs(BTC_ADDRESS[0], 3, GROUP_SATOSHI, keepers);

            const group = await system.getGroup(BTC_ADDRESS[0]);
            expect(group.required).equal(BigNumber.from(3));
            expect(group.maxSatoshi).equal(BigNumber.from(GROUP_SATOSHI));
            expect(group.currSatoshi).equal(BigNumber.from(0));
            expect(group.nonce).equal(BigNumber.from(0));
            expect(group.keepers).deep.equal(keepers);
            expect(group.workingReceiptId).equal(
                await system.getReceiptId(BTC_ADDRESS[0], group.nonce)
            );
        });
    });

    describe("deleteGroup()", function () {
        const btcAddress = BTC_ADDRESS[0];
        const withdrawBtcAddress = BTC_ADDRESS[1];
        const amountInSatoshi = GROUP_SATOSHI;
        const userSatsAmount = amountInSatoshi.mul(10 ** 10);
        const nonce = 1;
        const receiptId = getReceiptId(btcAddress, nonce);
        let keepers: string[];
        const txId = "0xa1658ce2e63e9f91b6ff5e75c5a69870b04de471f5cd1cc3e53be158b46169bd";
        const height = 1940801;

        beforeEach(async function () {
            keepers = group1Keepers.map((x) => x.address);

            await system.addGroup(btcAddress, 3, amountInSatoshi, keepers);
        });

        it("delete not exist", async function () {
            await expect(system.deleteGroup(BTC_ADDRESS[1]))
                .to.emit(system, "GroupDeleted")
                .withArgs(BTC_ADDRESS[1]);
        });

        it("should delete group", async function () {
            let group = await system.getGroup(btcAddress);
            expect(group.required).equal(BigNumber.from(3));
            expect(group.maxSatoshi).equal(BigNumber.from(amountInSatoshi));
            expect(group.currSatoshi).equal(BigNumber.from(0));
            expect(group.nonce).equal(BigNumber.from(0));
            expect(group.keepers).deep.equal(keepers);
            expect(group.workingReceiptId).equal(
                await system.getReceiptId(btcAddress, group.nonce)
            );

            await expect(system.deleteGroup(btcAddress))
                .to.emit(system, "GroupDeleted")
                .withArgs(btcAddress);

            group = await system.getGroup(btcAddress);
            expect(group.required).equal(BigNumber.from(0));
            expect(group.maxSatoshi).equal(BigNumber.from(0));
            expect(group.currSatoshi).equal(BigNumber.from(0));
            expect(group.nonce).equal(BigNumber.from(0));
            expect(group.keepers).deep.equal([]);
            expect(group.workingReceiptId).equal(await system.getReceiptId(btcAddress, 0));
        });

        it("delete group twice", async function () {
            await expect(system.deleteGroup(btcAddress))
                .to.emit(system, "GroupDeleted")
                .withArgs(btcAddress);

            await expect(system.deleteGroup(btcAddress))
                .to.emit(system, "GroupDeleted")
                .withArgs(btcAddress);
        });

        it("add same address", async function () {
            await expect(system.deleteGroup(btcAddress))
                .to.emit(system, "GroupDeleted")
                .withArgs(btcAddress);

            await system.addGroup(btcAddress, 2, amountInSatoshi, [
                users[2].address,
                users[3].address,
            ]);
            const group = await system.getGroup(btcAddress);
            expect(group.required).equal(BigNumber.from(2)); // new group `required`
        });

        it("delete group when deposit in progress", async function () {
            await system.connect(users[0]).requestMint(btcAddress, amountInSatoshi, nonce);

            await expect(system.connect(deployer).deleteGroup(btcAddress)).to.revertedWith(
                "deposit in progress"
            );
        });

        it("delete group when mint timeout", async function () {
            await system.connect(users[0]).requestMint(btcAddress, amountInSatoshi, nonce);

            await advanceTimeAndBlock(24 * 3600);

            await expect(system.connect(deployer).deleteGroup(btcAddress))
                .to.emit(system, "GroupDeleted")
                .withArgs(btcAddress);
        });

        it("delete group when mint revoked", async function () {
            await system.connect(users[0]).requestMint(btcAddress, amountInSatoshi, nonce);

            await system.connect(users[0]).revokeMint(receiptId);

            await expect(system.connect(deployer).deleteGroup(btcAddress)).to.revertedWith(
                "receipt in resuing gap"
            );

            await advanceTimeAndBlock(3600);

            await expect(system.connect(deployer).deleteGroup(btcAddress))
                .to.emit(system, "GroupDeleted")
                .withArgs(btcAddress);
        });

        it("delete group when mint verified", async function () {
            await system.connect(users[0]).requestMint(btcAddress, amountInSatoshi, nonce);

            const [rList, sList, packedV] = await prepareSignature(
                group1Verifiers,
                system.address,
                receiptId,
                txId,
                height
            );

            const keeperAddresses = group1Verifiers.map((x) => x.address);
            await system
                .connect(users[0])
                .verifyMint({ receiptId, txId, height }, keeperAddresses, rList, sList, packedV);

            await expect(system.connect(deployer).deleteGroup(btcAddress)).to.revertedWith(
                "group balance > 0"
            );
        });

        it("delete group when burn requested", async function () {
            await system.connect(users[0]).requestMint(btcAddress, amountInSatoshi, nonce);
            const [rList, sList, packedV] = await prepareSignature(
                group1Verifiers,
                system.address,
                receiptId,
                txId,
                height
            );
            const keeperAddresses = group1Verifiers.map((x) => x.address);
            await system
                .connect(users[0])
                .verifyMint({ receiptId, txId, height }, keeperAddresses, rList, sList, packedV);
            await sats.connect(users[0]).approve(system.address, userSatsAmount);
            await system.connect(users[0]).requestBurn(receiptId, withdrawBtcAddress);

            await expect(system.connect(deployer).deleteGroup(btcAddress)).to.revertedWith(
                "withdraw in progress"
            );

            await advanceTimeAndBlock(48 * 3600);

            await expect(system.connect(deployer).deleteGroup(btcAddress))
                .to.emit(system, "GroupDeleted")
                .withArgs(btcAddress);
        });

        it("delete group when burn verified", async function () {
            await system.connect(users[0]).requestMint(btcAddress, amountInSatoshi, nonce);
            const [rList, sList, packedV] = await prepareSignature(
                group1Verifiers,
                system.address,
                receiptId,
                txId,
                height
            );

            const keeperAddresses = group1Verifiers.map((x) => x.address);
            await system
                .connect(users[0])
                .verifyMint({ receiptId, txId, height }, keeperAddresses, rList, sList, packedV);
            await sats.connect(users[0]).approve(system.address, userSatsAmount);
            await system.connect(users[0]).requestBurn(receiptId, withdrawBtcAddress);
            await system.connect(users[0]).verifyBurn(receiptId);

            await expect(system.connect(deployer).deleteGroup(btcAddress)).to.revertedWith(
                "receipt in resuing gap"
            );

            await advanceTimeAndBlock(3600);

            await expect(system.connect(deployer).deleteGroup(btcAddress))
                .to.emit(system, "GroupDeleted")
                .withArgs(btcAddress);
        });
    });

    const addMockGroup = async (): Promise<void> => {
        await system.addGroup(
            BTC_ADDRESS[0],
            3,
            GROUP_SATOSHI,
            group1Keepers.map((x) => x.address)
        );
        await system.addGroup(
            BTC_ADDRESS[1],
            3,
            GROUP_SATOSHI,
            group2Keepers.map((x) => x.address)
        );
    };

    const requestMint = async (
        user: Wallet,
        btcAddress: string,
        nonce: number
    ): Promise<string> => {
        await system.connect(user).requestMint(btcAddress, GROUP_SATOSHI, nonce);
        return getReceiptId(btcAddress, nonce);
    };

    const verifyMint = async (
        user: Wallet,
        keepers: Wallet[],
        receiptId: string,
        txId: string,
        height: number
    ): Promise<ContractTransaction> => {
        const [rList, sList, packedV] = await prepareSignature(
            keepers,
            system.address,
            receiptId,
            txId,
            height
        );

        const keeperAddresses = keepers.map((x) => x.address);
        return await system
            .connect(user)
            .verifyMint({ receiptId, txId, height }, keeperAddresses, rList, sList, packedV);
    };

    describe("requestMint()", function () {
        const btcAddress = BTC_ADDRESS[0];
        const amountInSatoshi = GROUP_SATOSHI;
        const nonce = 1;
        const receiptId = getReceiptId(btcAddress, nonce);

        beforeEach(async function () {
            await addMockGroup();
        });

        it("invalid nonce", async function () {
            await expect(
                system.connect(users[0]).requestMint(btcAddress, amountInSatoshi, nonce + 1)
            ).to.revertedWith("invalid nonce");
        });

        it("should request mint", async function () {
            let group = await system.getGroup(btcAddress);
            expect(group.nonce).equal(nonce - 1);

            await expect(system.connect(users[0]).requestMint(btcAddress, amountInSatoshi, nonce))
                .to.emit(system, "MintRequested")
                .withArgs(receiptId, users[0].address, amountInSatoshi, BTC_ADDRESS[0]);

            group = await system.getGroup(btcAddress);
            expect(group.nonce).equal(nonce);
        });

        it("revoke mint", async function () {
            let group = await system.getGroup(btcAddress);
            expect(group.nonce).equal(nonce - 1);
            expect((await system.getGroup(btcAddress))[3]).to.equal(nonce - 1);

            await system.connect(users[0]).requestMint(btcAddress, amountInSatoshi, nonce);

            group = await system.getGroup(btcAddress);
            expect(group.nonce).equal(nonce);
            expect((await system.getReceipt(receiptId)).status).to.equal(1);

            await expect(system.connect(users[1]).revokeMint(receiptId)).to.revertedWith(
                "require receipt recipient"
            );

            await expect(system.connect(users[0]).revokeMint(receiptId))
                .to.emit(system, "MintRevoked")
                .withArgs(receiptId, btcAddress, users[0].address);

            group = await system.getGroup(btcAddress);
            expect(group.nonce).equal(nonce);
            expect((await system.getReceipt(receiptId)).status).to.equal(0);
        });

        it("force mint request", async function () {
            let group = await system.getGroup(btcAddress);
            expect(group.nonce).equal(nonce - 1);

            await system.connect(users[0]).requestMint(btcAddress, amountInSatoshi, nonce);

            group = await system.getGroup(btcAddress);
            expect(group.nonce).equal(nonce);

            const nonce2 = nonce + 1;
            await expect(
                system.connect(users[1]).forceRequestMint(btcAddress, GROUP_SATOSHI, nonce2)
            ).to.revertedWith("deposit in progress");

            await advanceTimeAndBlock(24 * 3600);

            group = await system.getGroup(btcAddress);
            expect(group.nonce).equal(nonce);

            const receiptId2 = getReceiptId(btcAddress, nonce2);
            await expect(
                system.connect(users[1]).forceRequestMint(btcAddress, GROUP_SATOSHI, nonce2)
            )
                .to.emit(system, "MintRevoked")
                .withArgs(receiptId, btcAddress, users[1].address)
                .to.emit(system, "MintRequested")
                .withArgs(receiptId2, users[1].address, GROUP_SATOSHI, btcAddress);

            group = await system.getGroup(btcAddress);
            expect(group.nonce).equal(nonce + 1);
        });
    });

    describe("verifyMint()", function () {
        const btcAddress = BTC_ADDRESS[0];
        const nonce = 1;
        let receiptId: string;
        const txId = "0xa1658ce2e63e9f91b6ff5e75c5a69870b04de471f5cd1cc3e53be158b46169bd";
        const height = 1940801;
        const groupSatsAmount = GROUP_SATOSHI.mul(SATOSHI_SATS_MULTIPLIER);

        beforeEach(async function () {
            await addMockGroup();

            receiptId = await requestMint(users[0], btcAddress, nonce);
        });

        it("should verify mint", async function () {
            let receipt = await system.getReceipt(receiptId);
            let group = await system.getGroup(btcAddress);
            expect(receipt.status).to.be.equal(Status.DepositRequested);
            expect(receipt.txId).to.be.equal(constants.HashZero);
            expect(receipt.height).to.be.equal(0);
            expect(group[2]).to.be.equal(0);
            expect(group[3]).to.be.equal(nonce);

            const keepers = group1Verifiers;
            const [rList, sList, packedV] = await prepareSignature(
                keepers,
                system.address,
                receiptId,
                txId,
                height
            );

            const keeperAddresses = keepers.map((x) => x.address);
            await expect(
                system
                    .connect(users[0])
                    .verifyMint({ receiptId, txId, height }, keeperAddresses, rList, sList, packedV)
            )
                .to.emit(system, "MintVerified")
                .withArgs(receiptId, btcAddress, keeperAddresses, txId, height);

            receipt = await system.getReceipt(receiptId);
            group = await system.getGroup(btcAddress);
            expect(receipt.status).to.be.equal(Status.DepositReceived);
            expect(receipt.txId).to.be.equal(txId);
            expect(receipt.height).to.be.equal(height);
            expect(group[2]).to.be.equal(GROUP_SATOSHI);
            expect(group[3]).to.be.equal(nonce);

            expect(await sats.balanceOf(users[0].address)).to.be.equal(groupSatsAmount);
        });

        it("verify mint repeated keeper", async function () {
            const verifier = [group1Verifiers[0], group1Verifiers[1], group1Verifiers[1]];

            const keepers = verifier;
            const [rList, sList, packedV] = await prepareSignature(
                keepers,
                system.address,
                receiptId,
                txId,
                height
            );

            const keeperAddresses = keepers.map((x) => x.address);
            await expect(
                system
                    .connect(users[0])
                    .verifyMint({ receiptId, txId, height }, keeperAddresses, rList, sList, packedV)
            ).to.revertedWith("keeper is in cooldown");
        });

        it("verify mint timeout", async function () {
            await advanceTimeAndBlock(24 * 3600); // > MINT_REQUEST_GRACE_PERIOD

            let group = await system.getGroup(btcAddress);
            expect(group.currSatoshi).equal(0);

            const keepers = group1Verifiers;
            const [rList, sList, packedV] = await prepareSignature(
                keepers,
                system.address,
                receiptId,
                txId,
                height
            );

            const keeperAddresses = keepers.map((x) => x.address);
            await expect(
                system
                    .connect(users[0])
                    .verifyMint({ receiptId, txId, height }, keeperAddresses, rList, sList, packedV)
            )
                .to.emit(system, "MintVerified")
                .withArgs(receiptId, btcAddress, keeperAddresses, txId, height);

            group = await system.getGroup(btcAddress);
            expect(group.currSatoshi).equal(GROUP_SATOSHI);
        });

        it("forbit verify for outdated receipt", async function () {
            await advanceTimeAndBlock(24 * 3600);

            const nonce2 = nonce + 1;
            const receiptId2 = getReceiptId(btcAddress, nonce2);
            await expect(
                system.connect(users[1]).forceRequestMint(btcAddress, GROUP_SATOSHI, nonce2)
            )
                .to.emit(system, "MintRevoked")
                .withArgs(receiptId, btcAddress, users[1].address)
                .to.emit(system, "MintRequested")
                .withArgs(receiptId2, users[1].address, GROUP_SATOSHI, btcAddress);

            const keepers = group1Verifiers;
            const [rList, sList, packedV] = await prepareSignature(
                keepers,
                system.address,
                receiptId,
                txId,
                height
            );

            const keeperAddresses = keepers.map((x) => x.address);
            await expect(
                system
                    .connect(users[0])
                    .verifyMint({ receiptId, txId, height }, keeperAddresses, rList, sList, packedV)
            ).to.revertedWith("keeper is not in group");
        });

        it("forbit verify for cancelled", async function () {
            await expect(system.connect(users[0]).revokeMint(receiptId))
                .to.emit(system, "MintRevoked")
                .withArgs(receiptId, btcAddress, users[0].address);

            const keepers = group1Verifiers;
            const [rList, sList, packedV] = await prepareSignature(
                keepers,
                system.address,
                receiptId,
                txId,
                height
            );

            const keeperAddresses = keepers.map((x) => x.address);
            await expect(
                system
                    .connect(users[0])
                    .verifyMint({ receiptId, txId, height }, keeperAddresses, rList, sList, packedV)
            ).to.revertedWith("receipt is not in DepositRequested state");
        });
    });

    describe("requestBurn()", function () {
        const btcAddress = BTC_ADDRESS[0];
        const withdrawBtcAddress = BTC_ADDRESS[1];
        const nonce = 1;
        let receiptId: string;
        const txId = "0xa1658ce2e63e9f91b6ff5e75c5a69870b04de471f5cd1cc3e53be158b46169bd";
        const height = 1940801;
        const userSatsAmount = GROUP_SATOSHI.mul(SATOSHI_SATS_MULTIPLIER);

        beforeEach(async function () {
            await addMockGroup();

            receiptId = await requestMint(users[0], btcAddress, nonce);

            await verifyMint(users[0], group1Verifiers, receiptId, txId, height);
        });

        it("request burn", async function () {
            const redeemer = users[1];
            await sats.connect(users[0]).transfer(redeemer.address, userSatsAmount);

            await sats.connect(redeemer).approve(system.address, userSatsAmount);
            let receipt = await system.getReceipt(receiptId);
            expect(receipt.recipient).to.equal(users[0].address);

            await expect(system.connect(redeemer).requestBurn(receiptId, withdrawBtcAddress))
                .to.emit(system, "BurnRequested")
                .withArgs(receiptId, btcAddress, withdrawBtcAddress, redeemer.address);

            receipt = await system.getReceipt(receiptId);
            expect(receipt.recipient).to.equal(redeemer.address);
            expect(receipt.status).to.be.equal(3);
            expect(receipt.withdrawBtcAddress).to.be.equal(withdrawBtcAddress);
            expect(await sats.balanceOf(redeemer.address)).to.be.equal(0);
            expect(await sats.balanceOf(system.address)).to.be.equal(userSatsAmount);
        });

        it("recover burn", async function () {
            const redeemer = users[0];
            expect(await sats.balanceOf(redeemer.address)).to.be.equal(userSatsAmount);
            await sats.connect(redeemer).approve(system.address, userSatsAmount);

            await expect(system.connect(redeemer).requestBurn(receiptId, withdrawBtcAddress))
                .to.emit(system, "BurnRequested")
                .withArgs(receiptId, btcAddress, withdrawBtcAddress, redeemer.address);

            expect(await sats.balanceOf(redeemer.address)).to.be.equal(0);
            let receipt = await system.getReceipt(receiptId);
            expect(receipt.status).to.equal(Status.WithdrawRequested);

            await expect(system.connect(redeemer).recoverBurn(receiptId)).to.revertedWith(
                "require admin role"
            );

            await expect(system.connect(deployer).recoverBurn(receiptId))
                .to.emit(system, "BurnRevoked")
                .withArgs(receiptId, btcAddress, redeemer.address, deployer.address);

            receipt = await system.getReceipt(receiptId);
            expect(receipt.status).to.equal(Status.DepositReceived);
            expect(await sats.balanceOf(redeemer.address)).to.be.equal(userSatsAmount);
        });
    });

    describe("verifyBurn()", function () {
        const btcAddress = BTC_ADDRESS[0];
        const withdrawBtcAddress = BTC_ADDRESS[1];
        const nonce = 1;
        let receiptId: string;
        const txId = "0xa1658ce2e63e9f91b6ff5e75c5a69870b04de471f5cd1cc3e53be158b46169bd";
        const height = 1940801;
        const userSatsAmount = GROUP_SATOSHI.mul(SATOSHI_SATS_MULTIPLIER);

        beforeEach(async function () {
            await addMockGroup();

            receiptId = await requestMint(users[0], btcAddress, nonce);

            await verifyMint(users[0], group1Verifiers, receiptId, txId, height);

            await sats.connect(users[0]).approve(system.address, userSatsAmount);
            await system.connect(users[0]).requestBurn(receiptId, withdrawBtcAddress);
        });

        it("verify burn", async function () {
            await expect(system.connect(users[0]).verifyBurn(receiptId))
                .to.emit(system, "BurnVerified")
                .withArgs(receiptId, btcAddress, users[0].address);

            const receipt = await system.getReceipt(receiptId);
            expect(receipt.status).to.be.equal(0);
            expect(await sats.balanceOf(users[0].address)).to.be.equal(0);
            expect(await sats.balanceOf(system.address)).to.be.equal(0);

            const nonce2 = nonce + 1;
            const receiptId2 = getReceiptId(btcAddress, nonce2);

            await expect(
                system.connect(users[1]).requestMint(btcAddress, GROUP_SATOSHI, nonce2)
            ).to.revertedWith("group cooling down");

            await advanceTimeAndBlock(3600);

            await expect(system.connect(users[1]).requestMint(btcAddress, GROUP_SATOSHI, nonce2))
                .to.emit(system, "MintRequested")
                .withArgs(receiptId2, users[1].address, GROUP_SATOSHI, btcAddress);
        });

        it("verify burn timeout", async function () {
            await advanceTimeAndBlock(24 * 3600); // > WITHDRAW_VERIFICATION_END

            await expect(system.connect(users[0]).verifyBurn(receiptId))
                .to.emit(system, "BurnVerified")
                .withArgs(receiptId, btcAddress, users[0].address);
        });

        it("mint without verify burn", async function () {
            await advanceTimeAndBlock(24 * 60 * 60);

            const nonce2 = nonce + 1;
            await expect(
                system.connect(users[1]).requestMint(btcAddress, GROUP_SATOSHI, nonce2)
            ).to.be.revertedWith("working receipt in progress");

            const receiptId2 = getReceiptId(btcAddress, nonce2);
            await expect(
                system.connect(users[1]).forceRequestMint(btcAddress, GROUP_SATOSHI, nonce2)
            )
                .to.emit(system, "BurnVerified")
                .withArgs(receiptId, btcAddress, users[1].address)
                .to.emit(system, "MintRequested")
                .withArgs(receiptId2, users[1].address, GROUP_SATOSHI, btcAddress);

            const group = await system.getGroup(btcAddress);
            expect(group[2]).to.be.equal(0);
            expect(group[3]).to.be.equal(nonce2);
            const receipt = await system.getReceipt(receiptId2);
            expect(receipt.status).to.be.equal(1);
        });
    });

    describe("refundBtc()", function () {
        const btcAddress = BTC_ADDRESS[0];
        const nonce = 1;
        let receiptId: string;
        const txId = "0xa1658ce2e63e9f91b6ff5e75c5a69870b04de471f5cd1cc3e53be158b46169bd";
        const height = 1940801;

        beforeEach(async function () {
            await addMockGroup();
        });

        it("refund recorded", async function () {
            const expiryTimestamp = (await system.REFUND_GAP()) + (1 + (await currentTime()));
            await expect(system.refundBtc(btcAddress, txId))
                .to.emit(system, "BtcRefunded")
                .withArgs(btcAddress, txId, expiryTimestamp);

            const refundData = await system.getRefundData();
            expect(refundData.groupBtcAddress).to.be.equal(btcAddress);
            expect(refundData.txId).to.be.equal(txId);
            expect(refundData.expiryTimestamp).to.be.equal(expiryTimestamp);
        });

        it("refund fail with verified mint", async function () {
            receiptId = await requestMint(users[0], btcAddress, nonce);
            await verifyMint(users[0], group1Verifiers, receiptId, txId, height);

            await expect(system.refundBtc(btcAddress, txId)).to.revertedWith(
                "receipt not in available state"
            );
        });

        it("refund with clear receipt", async function () {
            receiptId = await requestMint(users[0], btcAddress, nonce);

            await expect(system.refundBtc(btcAddress, txId)).to.revertedWith("deposit in progress");

            await advanceTimeAndBlock(24 * 3600);

            const expiryTimestamp = (await system.REFUND_GAP()) + (1 + (await currentTime()));

            await expect(system.refundBtc(btcAddress, txId))
                .to.emit(system, "MintRevoked")
                .withArgs(receiptId, btcAddress, deployer.address)
                .to.emit(system, "BtcRefunded")
                .withArgs(btcAddress, txId, expiryTimestamp);
        });

        it("refund cool down", async function () {
            const refundGap = await system.REFUND_GAP();
            const expiryTimestamp = refundGap + (1 + (await currentTime()));
            await expect(system.refundBtc(btcAddress, txId))
                .to.emit(system, "BtcRefunded")
                .withArgs(btcAddress, txId, expiryTimestamp);

            const txId2 = "0xa1658ce2e63e9f91b6ff5e75c5a69870b04de471f5cd1cc3e53be158b46169be";
            await expect(system.refundBtc(btcAddress, txId2)).to.revertedWith("refund cool down");

            await advanceTimeAndBlock(24 * 3600);

            const expiryTimestamp2 = refundGap + (1 + (await currentTime()));
            await expect(system.refundBtc(btcAddress, txId2))
                .to.emit(system, "BtcRefunded")
                .withArgs(btcAddress, txId2, expiryTimestamp2);
        });
    });
    describe("fee() & reward()", function () {
        const btcAddress = BTC_ADDRESS[0];
        const btcAddress2 = BTC_ADDRESS[1];
        const withdrawBtcAddress = BTC_ADDRESS[2];
        const nonce = 1;
        const txId = "0xa1658ce2e63e9f91b6ff5e75c5a69870b04de471f5cd1cc3e53be158b46169bd";
        const height = 1940801;
        const groupSatsAmount = GROUP_SATOSHI.mul(SATOSHI_SATS_MULTIPLIER);
        const mintFeeBps = 1;
        const burnFeeBps = 5;
        let dcsMintReward: BigNumber;
        let dcsBurnReward: BigNumber;

        beforeEach(async function () {
            await addMockGroup();
            await system.updateMintFeeBps(mintFeeBps);
            await system.updateBurnFeeBps(burnFeeBps);

            dcsMintReward = await rewarder.mintRewardAmount();
            dcsBurnReward = await rewarder.burnRewardAmount();
        });

        it("reward not empty", async function () {
            expect(dcsMintReward).to.gt(parseEther("1"));
            expect(dcsBurnReward).to.gt(parseEther("1"));
        });

        it("mint & burn", async function () {
            const user = users[0];

            let dcsReward = BigNumber.from(0);
            expect(await dcs.balanceOf(user.address)).to.equal(dcsReward);

            // first mint
            const receiptId = await requestMint(user, btcAddress, nonce);
            let tx = await verifyMint(user, group1Verifiers, receiptId, txId, height);
            expect(tx).emit(rewarder, "SwapRewarded").withArgs(user.address, dcsMintReward, true);

            let userAmount = groupSatsAmount.mul(10000 - mintFeeBps).div(10000);
            let systemAmount = groupSatsAmount.mul(mintFeeBps).div(10000);
            expect(await sats.balanceOf(user.address)).to.equal(userAmount);
            expect(await sats.balanceOf(system.address)).to.equal(systemAmount);

            dcsReward = dcsReward.add(dcsMintReward);
            expect(await dcs.balanceOf(user.address)).to.equal(dcsReward);

            await advanceTimeAndBlock(24 * 3600);

            // second mint
            const receiptId2 = await requestMint(user, btcAddress2, nonce);
            tx = await verifyMint(user, group2Verifiers, receiptId2, txId, height);
            expect(tx).emit(rewarder, "SwapRewarded").withArgs(user.address, dcsMintReward, true);

            systemAmount = systemAmount.mul(2);
            userAmount = userAmount.mul(2);
            expect(await sats.balanceOf(system.address)).to.equal(systemAmount);
            expect(await sats.balanceOf(user.address)).to.equal(userAmount);

            dcsReward = dcsReward.add(dcsMintReward);
            expect(await dcs.balanceOf(user.address)).to.equal(dcsReward);

            // burn
            const payAmount = groupSatsAmount.mul(10000 + burnFeeBps).div(10000);
            systemAmount = systemAmount.add(groupSatsAmount.mul(burnFeeBps).div(10000));
            await sats.connect(user).approve(system.address, payAmount);
            await system.connect(user).requestBurn(receiptId, withdrawBtcAddress);

            expect(await sats.balanceOf(system.address)).to.equal(
                systemAmount.add(groupSatsAmount)
            );

            expect(await dcs.balanceOf(user.address)).to.equal(dcsReward);

            // verify burn
            await expect(system.connect(user).verifyBurn(receiptId))
                .to.emit(rewarder, "SwapRewarded")
                .withArgs(user.address, dcsBurnReward, false);

            expect(await sats.balanceOf(system.address)).to.equal(systemAmount);

            dcsReward = dcsReward.add(dcsBurnReward);
            expect(await dcs.balanceOf(user.address)).to.equal(dcsReward);

            // admin collect fee
            expect(await sats.balanceOf(deployer.address)).to.equal(0);

            await expect(system.connect(deployer).collectFee(systemAmount))
                .to.emit(system, "FeeCollected")
                .withArgs(deployer.address, systemAmount);

            expect(await sats.balanceOf(system.address)).to.equal(0);
            expect(await sats.balanceOf(deployer.address)).to.equal(systemAmount);
        });
    });

    describe("pause()", function () {
        const btcAddress = BTC_ADDRESS[0];
        const withdrawBtcAddress = BTC_ADDRESS[1];
        const amountInSatoshi = GROUP_SATOSHI;
        const nonce = 1;
        const receiptId = getReceiptId(btcAddress, nonce);
        const txId = "0xa1658ce2e63e9f91b6ff5e75c5a69870b04de471f5cd1cc3e53be158b46169bd";
        const height = 1940801;

        beforeEach(async function () {
            await addMockGroup();

            await system.pause();
        });

        it("pause for group", async function () {
            await expect(
                system
                    .connect(deployer)
                    .addGroup(btcAddress, 2, amountInSatoshi, [users[2].address, users[3].address])
            ).to.revertedWith("Pausable: paused");

            await expect(system.connect(deployer).deleteGroup(btcAddress)).to.revertedWith(
                "Pausable: paused"
            );
        });

        it("pause for mint & burn", async function () {
            await expect(
                system.connect(users[0]).requestMint(btcAddress, amountInSatoshi, nonce)
            ).to.revertedWith("Pausable: paused");

            const [rList, sList, packedV] = await prepareSignature(
                group1Verifiers,
                system.address,
                receiptId,
                txId,
                height
            );

            const keeperAddresses = group1Verifiers.map((x) => x.address);
            await expect(
                system
                    .connect(users[0])
                    .verifyMint({ receiptId, txId, height }, keeperAddresses, rList, sList, packedV)
            ).to.revertedWith("Pausable: paused");

            await expect(
                system.connect(users[0]).requestBurn(receiptId, withdrawBtcAddress)
            ).to.revertedWith("Pausable: paused");

            await expect(system.connect(users[0]).verifyBurn(receiptId)).to.revertedWith(
                "Pausable: paused"
            );
        });
    });
});
